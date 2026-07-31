// The skills API — connecting a source, scanning the catalog, installing.
//
// The model: source (a GitHub repo) → skill (a catalog entry) → install
// (a scope). In detail: migrations/006-skills.ts and skill-store.ts.
//
// NETWORK REQUESTS live in this layer: the GitHub API and tarball downloads.
// They can be slow (a large repo), so each of them has a timeout (`github.ts`).

import { Hono } from 'hono'
import { auditWrite } from '../audit.ts'
import { parseGithubRef } from '../github.ts'
import {
  readProject,
  deleteSkillSource,
  readSkillSources,
  readSkillSource,
  createSkillSource,
  readSkill,
  installSkill,
  uninstallSkill,
  syncSkills,
  readSkills,
} from '../repo.ts'
import {
  deleteSourceFromStore,
  scanSource,
  skillToStore,
  deleteSkillFromStore,
  skillStorePath,
} from '../skill-store.ts'
import { builtinToStore } from '../builtin-skills.ts'
import { rmSync } from 'node:fs'
export const skillsRoutes = new Hono()

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

skillsRoutes.get('/skills', (c) => {
  return c.json({ skills: readSkills(), sources: readSkillSources() })
})

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

skillsRoutes.get('/skills/sources', (c) => {
  return c.json({ sources: readSkillSources() })
})

/**
 * Connecting a new source — the repo is scanned and written into the catalog.
 *
 * IT DOES NOT INSTALL: the skills only appear in the catalog. Downloading them
 * to disk is a separate step (`/skills/:id/install`), because the user decides
 * for themselves which skill they want where.
 */
skillsRoutes.post('/skills/source', async (c) => {
  let url: unknown
  try {
    const body = (await c.req.json()) as { url?: unknown }
    url = body?.url
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  if (typeof url !== 'string' || !url.trim()) {
    return c.json({ error: 'Repository URL is required' }, 400)
  }

  const ref = parseGithubRef(url)
  if (!ref) {
    return c.json(
      {
        error: 'Could not parse the URL',
        detail: 'For example: https://github.com/anthropics/skills or anthropics/skills',
      },
      400,
    )
  }

  let scan: Awaited<ReturnType<typeof scanSource>>
  try {
    scan = await scanSource(ref)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Scan failed' }, 502)
  }

  const source = createSkillSource({
    kind: 'github',
    url: url.trim(),
    owner: ref.owner,
    repo: ref.repo,
    ref: scan.ref,
  })

  const result = syncSkills(source.id, scan.skills, scan.sha)

  auditWrite(
    'user',
    'Skill source connected',
    `${ref.owner}/${ref.repo} — ${result.added} skill`,
    'write',
  )

  return c.json({ source, ...result, warnings: scan.warnings }, 201)
})

/** Re-scan — a skill newly added to the repo lands in the catalog */
skillsRoutes.post('/skills/source/:id/sync', async (c) => {
  const source = readSkillSource(c.req.param('id'))
  if (!source) return c.json({ error: 'Source not found' }, 404)

  let scan: Awaited<ReturnType<typeof scanSource>>
  try {
    scan = await scanSource({ owner: source.owner, repo: source.repo, ref: source.ref })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Scan failed' }, 502)
  }

  const result = syncSkills(source.id, scan.skills, scan.sha)

  auditWrite(
    'user',
    'Skill source synced',
    `${source.owner}/${source.repo} — +${result.added} / -${result.deleted}`,
    'write',
  )

  return c.json({ ...result, warnings: scan.warnings })
})

/** The source, its skills (CASCADE) and its store folder are removed */
skillsRoutes.delete('/skills/source/:id', (c) => {
  const id = c.req.param('id')
  const source = readSkillSource(id)
  if (!source) return c.json({ error: 'Source not found' }, 404)

  deleteSkillSource(id)
  deleteSourceFromStore(id)

  auditWrite(
    'user',
    'Skill source removed',
    `${source.owner}/${source.repo}`,
    'write',
  )

  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

interface InstallBody {
  /** `global` — everywhere; `project` — only in the projects in `projectIds` */
  scope?: unknown
  projectIds?: unknown
}

/**
 * Installs the skill: the files land in the store, the scope goes into the
 * database.
 *
 * A single call can install into SEVERAL projects — the files still sit there
 * in one copy, only the `skill_installs` rows multiply. The copy into the
 * project folders happens at the start of a session (`syncToProject`).
 */
skillsRoutes.post('/skills/:id/install', async (c) => {
  const skill = readSkill(c.req.param('id'))
  if (!skill) return c.json({ error: 'Skill not found' }, 404)

  const source = readSkillSource(skill.sourceId)
  if (!source) return c.json({ error: 'Skill source not found' }, 404)

  let body: InstallBody
  try {
    body = (await c.req.json()) as InstallBody
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  const scope = body.scope
  if (scope !== 'global' && scope !== 'project') {
    return c.json({ error: "scope must be 'global' or 'project'" }, 400)
  }

  let projects: string[] = []
  if (scope === 'project') {
    if (!Array.isArray(body.projectIds) || body.projectIds.length === 0) {
      return c.json({ error: 'Project scope needs at least one project selected' }, 400)
    }
    projects = body.projectIds.filter((x): x is string => typeof x === 'string')
    for (const id of projects) {
      if (!readProject(id)) return c.json({ error: `Project not found: ${id}` }, 404)
    }
  }

  // The files go into the store. Even if it is already installed we download
  // again — the source may have been updated.
  //
  // The source kind branches here: builtin skills are copied from disk (no
  // network needed), GitHub ones are downloaded as a tarball. The result in
  // the store is identical either way — which is why every step after this is
  // shared.
  if (source.kind === 'builtin') {
    const target = skillStorePath(source.id, skill.id)
    // On a re-install the old state must not linger (same as on the GitHub path)
    rmSync(target, { recursive: true, force: true })
    if (!builtinToStore(skill.path, target)) {
      return c.json({ error: 'Built-in skill folder not found' }, 500)
    }
  } else {
    try {
      await skillToStore(
        { owner: source.owner, repo: source.repo, ref: source.ref },
        source.ref,
        skill.path,
        source.id,
        skill.id,
      )
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Download failed' },
        502,
      )
    }
  }

  if (scope === 'global') {
    installSkill(skill.id, 'global', null)
  } else {
    for (const projectId of projects) installSkill(skill.id, 'project', projectId)
  }

  auditWrite(
    'user',
    'Skill installed',
    `${skill.name} — ${scope === 'global' ? 'global' : `${projects.length} project`}`,
    'write',
  )

  return c.json({ skill: readSkill(skill.id) })
})

/**
 * Removes an installation.
 *
 * When the last installation goes, the files in the store are deleted too — a
 * skill used nowhere should not sit on disk taking up space. The catalog entry
 * stays, so re-installing is one click away.
 */
skillsRoutes.delete('/skills/:id/install', async (c) => {
  const skill = readSkill(c.req.param('id'))
  if (!skill) return c.json({ error: 'Skill not found' }, 404)

  let body: InstallBody
  try {
    body = (await c.req.json()) as InstallBody
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  const scope = body.scope
  if (scope !== 'global' && scope !== 'project') {
    return c.json({ error: "scope must be 'global' or 'project'" }, 400)
  }

  const projectIds = Array.isArray(body.projectIds)
    ? body.projectIds.filter((x): x is string => typeof x === 'string')
    : []

  if (scope === 'global') {
    uninstallSkill(skill.id, 'global', null)
  } else {
    if (projectIds.length === 0) {
      return c.json({ error: 'No project selected' }, 400)
    }
    for (const projectId of projectIds) uninstallSkill(skill.id, 'project', projectId)
  }

  // If it is left nowhere, clean up the files as well
  const updated = readSkill(skill.id)
  if (updated && updated.installs.length === 0) {
    deleteSkillFromStore(skill.sourceId, skill.id)
  }

  auditWrite('user', 'Skill installation removed', skill.name, 'write')

  return c.json({ skill: updated })
})
