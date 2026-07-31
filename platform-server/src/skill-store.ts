// The skill store and the copy into a project — the disk layer for skills.
//
// TWO PLACES, TWO JOBS:
//
//   STORE    ~/.platforma/skills-ombor/<sourceId>/<skillId>/
//            The SINGLE copy of an installed skill's files. Even when one
//            skill is used in 10 projects, there is only one copy here.
//
//   PROJECT  <workDir>/.platforma/skills/<name>/
//            A COPY out of the store. Built at the start of a session.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY A COPY AND NOT A SYMLINK: `environment.ts` uses `canonicalPath`  │
// │ when it checks a path — a symlink IS RESOLVED and the real path (the │
// │ store) ends up outside the working directory. The result would be a  │
// │ permission modal every time the model read a SKILL.md.               │
// │                                                                      │
// │ With a copy the boundary code is not touched at all: the file really │
// │ is inside the working directory. A side benefit — if the agent       │
// │ damages the copy the store stays intact, so one project cannot spoil │
// │ another project's skill.                                             │
// └──────────────────────────────────────────────────────────────────────┘
//
// `.platforma/skills/` is a MANAGED directory. The source of truth is the
// database (`skill_installs`). At the start of every session it is brought
// into line with the database: anything extra is deleted, anything missing is
// copied in. Whatever the user put there by hand disappears in the next
// session — deliberately so, because otherwise the state on disk and the
// state in the database would drift apart over time.

import { parseSkillFile } from '@platforma/ai'
import type { Skill } from '@platforma/shared'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  fetchTarball,
  findSkillFiles,
  type GithubRef,
  MAX_SKILL_BYTES,
  readBlob,
  repoInfo,
} from './github.ts'
import { readTar } from './tar.ts'

/** The store root — overridable through `PLATFORM_SKILLS` (that is what the tests pass) */
export function storeRoot(): string {
  const env = process.env.PLATFORM_SKILLS?.trim()
  if (env) return env
  return join(homedir(), '.platforma', 'skills-ombor')
}

/**
 * Turns a path segment into a safe name.
 *
 * The `id`s are UUIDs and therefore safe — but we do not trust a value that
 * came from outside (the same rule as in `work-dir.ts`).
 */
function safeName(x: string): string {
  return x.replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'
}

/** The store directory of a single skill */
export function skillStorePath(sourceId: string, skillId: string): string {
  return join(storeRoot(), safeName(sourceId), safeName(skillId))
}

// ---------------------------------------------------------------------------
// Catalog: scanning a repository
// ---------------------------------------------------------------------------

export interface ScanResult {
  ref: string
  sha: string
  skills: Omit<Skill, 'id' | 'sourceId' | 'installs'>[]
  warnings: string[]
}

/**
 * Finds every `SKILL.md` in the repository and reads its frontmatter.
 *
 * Every `SKILL.md` costs one blob request. Given the rate limit (60/hour) the
 * number of files scanned is capped — otherwise a large repository would
 * exhaust the limit in a single attempt.
 */
export const MAX_SCAN_FILES = 50

/** The cap on the unpacked tarball — zip bomb protection */
const MAX_TARBALL_UNPACKED = 200 * 1024 * 1024

export async function scanSource(r: GithubRef): Promise<ScanResult> {
  const warnings: string[] = []
  const { ref, sha } = await repoInfo(r)
  const { files, truncated } = await findSkillFiles(r, ref)

  if (truncated) {
    warnings.push('Repository too large — the file list is incomplete')
  }

  let list = files
  if (list.length > MAX_SCAN_FILES) {
    warnings.push(
      `Found ${list.length} skills, read the first ${MAX_SCAN_FILES}`,
    )
    list = list.slice(0, MAX_SCAN_FILES)
  }

  const skills: ScanResult['skills'] = []
  for (const file of list) {
    let raw: string
    try {
      raw = await readBlob(r, file.sha)
    } catch {
      // One unreadable file does not cost us the rest
      continue
    }

    // The directory name is the parent of `SKILL.md`. For a file at the root
    // it is the repository name.
    const dir = file.path.includes('/')
      ? (dirname(file.path).split('/').pop() ?? r.repo)
      : r.repo

    const parsed = parseSkillFile(raw, dir)
    if (!parsed) {
      warnings.push(`${file.path}: no description — skipped`)
      continue
    }

    skills.push({
      path: file.path,
      name: parsed.name,
      description: parsed.description,
      license: parsed.license,
      allowedTools: parsed.allowedTools,
      warnings: parsed.warnings,
    })
  }

  return { ref, sha, skills, warnings }
}

// ---------------------------------------------------------------------------
// Install: tarball → store
// ---------------------------------------------------------------------------

/**
 * Extracts a skill's directory from the repository tarball into the store.
 *
 * Since the tarball is the WHOLE repository, only the files under the
 * required prefix are taken. A GitHub archive has a single root directory
 * inside it (`skills-abc123/…`) — we drop that.
 */
export async function skillToStore(
  r: GithubRef,
  ref: string,
  skillPath: string,
  sourceId: string,
  skillId: string,
): Promise<{ files: number; bytes: number }> {
  const raw = await fetchTarball(r, ref)
  const entries = readTar(raw, MAX_TARBALL_UNPACKED)

  // `document-skills/pdf/SKILL.md` → `document-skills/pdf/`
  const skillDir = skillPath.includes('/') ? `${dirname(skillPath)}/` : ''

  const target = skillStorePath(sourceId, skillId)
  // No leftovers from an earlier state on a reinstall
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  let files = 0
  let bytes = 0

  for (const entry of entries) {
    // Strip the archive root: `skills-abc123/x/y` → `x/y`
    const trimmed = entry.path.slice(entry.path.indexOf('/') + 1)
    if (!trimmed.startsWith(skillDir)) continue

    const innerPath = trimmed.slice(skillDir.length)
    if (!innerPath) continue

    bytes += entry.contents.length
    if (bytes > MAX_SKILL_BYTES) {
      rmSync(target, { recursive: true, force: true })
      throw new Error(`Skill too large (${Math.round(MAX_SKILL_BYTES / 1024 / 1024)}MB limit)`)
    }

    // `readTar` has already sanitised the path (no `..`), but before writing
    // we check AGAIN that the final path is inside the target — a security
    // check should not rest on a single place.
    const full = join(target, innerPath)
    if (full !== target && !full.startsWith(`${target}/`)) continue

    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, entry.contents)
    files++
  }

  if (files === 0) {
    rmSync(target, { recursive: true, force: true })
    throw new Error(`Folder "${skillDir || '/'}" not found in the archive`)
  }

  return { files, bytes }
}

/** Deletes a skill's store directory (when an install is undone) */
export function deleteSkillFromStore(sourceId: string, skillId: string): void {
  rmSync(skillStorePath(sourceId, skillId), { recursive: true, force: true })
}

/** When a source is deleted its whole store directory goes with it */
export function deleteSourceFromStore(sourceId: string): void {
  rmSync(join(storeRoot(), safeName(sourceId)), { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Syncing into a project
// ---------------------------------------------------------------------------

/** The managed skill directory inside the working directory */
export const WORK_SKILL_DIR = join('.platforma', 'skills')

export interface SyncResult {
  copied: number
  deleted: number
}

/**
 * Brings `.platforma/skills/` in the working directory into line with the
 * given list of skills.
 *
 * DOES NOT THROW: if a copy fails, that one skill simply does not turn up.
 * A session works perfectly well without a skill — bringing the whole
 * conversation down for it would be wrong (the same rule as in
 * `project-context.ts`).
 */
export function syncToProject(workDir: string, skills: Skill[]): SyncResult {
  const root = join(workDir, WORK_SKILL_DIR)
  const result: SyncResult = { copied: 0, deleted: 0 }

  // A map by name. When two skills share a name THE FIRST one stays (pi does
  // the same) — there is only one directory name, so there is no other option.
  const wanted = new Map<string, Skill>()
  for (const s of skills) {
    const name = safeName(s.name)
    if (!wanted.has(name)) wanted.set(name, s)
  }

  try {
    mkdirSync(root, { recursive: true })
  } catch {
    return result
  }

  // 1) Delete the extras — directories that are not in the database
  let existing: string[] = []
  try {
    existing = readdirSync(root)
  } catch {
    existing = []
  }
  for (const dir of existing) {
    if (wanted.has(dir)) continue
    try {
      rmSync(join(root, dir), { recursive: true, force: true })
      result.deleted++
    } catch {
      // If it cannot be deleted we leave it — we try again next session
    }
  }

  // 2) Copy from the store. EVERY TIME, from scratch: the store may have been
  //    updated (a reinstall) or the agent may have damaged the copy. Skills
  //    are small (a few KB) — this is not an expensive operation.
  for (const [name, skill] of wanted) {
    const source = skillStorePath(skill.sourceId, skill.id)
    if (!existsSync(source)) continue

    const target = join(root, name)
    try {
      rmSync(target, { recursive: true, force: true })
      // `dereference` — a symlink in the store (if there is one) becomes a
      // plain file in the copy, so no link leads out of the working directory
      cpSync(source, target, { recursive: true, dereference: true })
      result.copied++
    } catch {
      continue
    }
  }

  return result
}
