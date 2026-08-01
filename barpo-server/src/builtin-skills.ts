// The builtin skills that ship with the platform.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THESE BEHAVE EXACTLY LIKE ORDINARY SKILLS.                           │
// │                                                                      │
// │ They pass through the catalog (the `skills` table), show up in the   │
// │ "Skill store" and the user installs and removes them as they please. │
// │ The only difference is the SOURCE: not GitHub, but the `skills/`     │
// │ directory inside the repo.                                           │
// │                                                                      │
// │ WHY LOCAL FOR NOW: the platform repository is private at the moment, │
// │ so it cannot be read through the GitHub API. When the repository is  │
// │ opened up the source moves to GitHub and ONLY this file changes —    │
// │ the catalog, install, store and UI flows stay as they are, because   │
// │ they do not know the kind of the source.                             │
// │                                                                      │
// │ That is precisely why the builtin skills go through the catalog from │
// │ the very start: so that there is no later pain of "migrating from a  │
// │ separate mechanism into the catalog".                                │
// └──────────────────────────────────────────────────────────────────────┘

import { parseSkillFile } from '@barpo/ai'
import type { Skill } from '@barpo/shared'
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The `url` field of the catalog source — this is what the UI shows */
export const BUILTIN_SOURCE_URL = 'barpo://builtin'

/**
 * The `owner`/`repo` values of the source row.
 *
 * `createSkillSource` detects duplicates by exactly this triple
 * (`owner`+`repo`+`ref`), so they MUST BE STABLE — otherwise a new source
 * would be created on every start-up.
 */
export const BUILTIN_OWNER = 'barpo'
export const BUILTIN_REPO = 'builtin-skills'

/**
 * The directory the builtin skills live in (inside the repo).
 *
 * `barpo-server/src/...` → two levels up → the monorepo root.
 */
export function builtinSkillDir(): string {
  return join(dirname(dirname(import.meta.dir)), 'skills')
}

export interface BuiltinScanResult {
  skills: Omit<Skill, 'id' | 'sourceId' | 'installs'>[]
  warnings: string[]
}

/**
 * Scans the local `skills/` directory.
 *
 * Returns a result in EXACTLY THE SAME shape as `scanSource` (GitHub) — the
 * caller cannot tell the two apart. When the repository is opened up, this
 * function is simply replaced by the GitHub variant, nothing more.
 *
 * DOES NOT THROW: when the directory is missing or a file cannot be read it
 * returns an empty list. The platform works perfectly well without the
 * builtin skills.
 */
export function scanBuiltins(): BuiltinScanResult {
  const root = builtinSkillDir()
  const warnings: string[] = []
  const skills: BuiltinScanResult['skills'] = []

  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return { skills, warnings }
  }

  for (const dir of dirs.sort()) {
    const skillMd = join(root, dir, 'SKILL.md')
    try {
      if (!statSync(join(root, dir)).isDirectory() || !existsSync(skillMd)) continue
    } catch {
      continue
    }

    let raw: string
    try {
      raw = readFileSync(skillMd, 'utf8')
    } catch {
      // One unreadable file does not cost us the rest (the GitHub scanner
      // follows the same rule).
      continue
    }

    const parsed = parseSkillFile(raw, dir)
    if (!parsed) {
      warnings.push(`${dir}: no description — skipped`)
      continue
    }

    skills.push({
      // The path has the same shape as in the GitHub variant:
      // `<dir>/SKILL.md`. When the source moves to GitHub the paths line up
      // and the catalog entries (and therefore the installs) survive.
      path: `${dir}/SKILL.md`,
      name: parsed.name,
      description: parsed.description,
      license: parsed.license,
      allowedTools: parsed.allowedTools,
      warnings: parsed.warnings,
    })
  }

  return { skills, warnings }
}

/**
 * Writes/updates the builtin source in the catalog.
 *
 * Called ON EVERY START-UP (unlike the seed, which only writes to an empty
 * database). The reason: when the platform is updated the builtin skills are
 * updated with it — a new one may be added, a description may change.
 *
 * `createSkillSource` and `syncSkills` are both idempotent: the source is
 * found by `owner`+`repo`+`ref`, and the skills are UPSERTed by
 * `source_id`+`path`. So a repeated call creates no duplicates and PRESERVES
 * EXISTING INSTALLS.
 *
 * DOES NOT THROW: if the catalog cannot be written the platform still starts,
 * only the builtin skills do not appear in the store.
 */
export function ensureBuiltinSource(
  createSource: (s: {
    kind: 'builtin'
    url: string
    owner: string
    repo: string
    ref: string
  }) => { id: string },
  syncSkills: (
    sourceId: string,
    found: Omit<Skill, 'id' | 'sourceId' | 'installs'>[],
    commitSha: string | null,
  ) => unknown,
): { sourceId: string; count: number } | null {
  try {
    const scan = scanBuiltins()
    if (scan.skills.length === 0) return null

    const source = createSource({
      kind: 'builtin',
      url: BUILTIN_SOURCE_URL,
      owner: BUILTIN_OWNER,
      repo: BUILTIN_REPO,
      ref: '',
    })

    // `commitSha: null` — a local directory has no notion of a commit. When
    // the repository moves to GitHub the real SHA lands here and the "is
    // there an update?" check starts working by itself.
    syncSkills(source.id, scan.skills, null)

    return { sourceId: source.id, count: scan.skills.length }
  } catch {
    return null
  }
}

/**
 * Copies a builtin skill into the store directory.
 *
 * The GitHub variant downloads and unpacks a tarball (`skillToStore`); this
 * one simply copies the directory across — the outcome is the same: the
 * skill's directory inside the store.
 *
 * `path` is the catalog value (`<dir>/SKILL.md`); the directory name is taken
 * from it.
 */
export function builtinToStore(path: string, target: string): boolean {
  const dir = path.includes('/') ? path.split('/')[0]! : path
  const source = join(builtinSkillDir(), dir)

  try {
    if (!existsSync(source)) return false
    cpSync(source, target, { recursive: true, dereference: true })
    return true
  } catch {
    return false
  }
}
