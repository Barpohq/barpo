// The directory the agent's tools operate in.
//
// There are two kinds of directory:
//
//   1) SESSION directory — ~/.platforma/ishlar/<sessionId>/
//      A conversation not attached to a project runs here: files created in
//      one conversation must not bleed into another.
//
//   2) PROJECT directory — ~/.platforma/loyihalar/<slug>/
//      A conversation attached to a project runs here. ALL of a project's
//      chats share one directory, so the user can open several conversations
//      over the same codebase.
//
// Both roots can be relocated with the `PLATFORM_WORKS` and `PLATFORM_PROJECTS`
// env vars (tests point them at a temporary directory).

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The root of every session directory */
export function worksRoot(): string {
  const env = process.env.PLATFORM_WORKS?.trim()
  if (env) return env
  return join(homedir(), '.platforma', 'ishlar')
}

/** The root of every project directory */
export function projectsRoot(): string {
  const env = process.env.PLATFORM_PROJECTS?.trim()
  if (env) return env
  return join(homedir(), '.platforma', 'loyihalar')
}

/**
 * Returns the work directory for a session, creating it if it does not exist.
 *
 * `sessionId` is a UUID, so it cannot contain anything dangerous for a path,
 * but we do not trust a value that came from outside — only safe characters
 * are kept.
 */
export function workDir(sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'
  const path = join(worksRoot(), safeId)
  mkdirSync(path, { recursive: true })
  return path
}

/**
 * Turns a project name into a directory name (a slug).
 *
 * ONLY `[a-zA-Z0-9_-]` is kept, everything else becomes `-`. No separate check
 * is NEEDED for `..`, `/`, NUL and the other path tricks: they are simply not
 * part of the safe character set, i.e. the filter works on an "allowed
 * characters" (allowlist) principle — unlike a denylist, it never raises the
 * question "which other character was dangerous again?".
 *
 * An empty result (a name made up entirely of emoji or Cyrillic) returns
 * `null` — the caller reports an error and does NOT fall back to a name like
 * "unknown": otherwise two differently named projects would share one
 * directory.
 */
export function projectSlug(name: string): string | null {
  const slug = name
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    // Leading and trailing dashes make for an ugly directory name
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    // Truncating can leave a dash at the end
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : null
}

/**
 * Creates the project directory and returns its full path.
 *
 * The slug already consists of safe characters only, so `join` cannot escape
 * the root.
 */
export function createProjectDir(slug: string): string {
  const path = join(projectsRoot(), slug)
  mkdirSync(path, { recursive: true })
  return path
}

/**
 * The ACTUAL work directory for a session.
 *
 * If it is attached to a project, the project directory; otherwise the
 * session's own directory. `projectFolder` comes from the caller (read out of
 * the repo layer) — this module knows nothing about the database.
 *
 * The directory is created in both cases: the project row can exist in the
 * database while its directory has been deleted by hand. Without the
 * directory, `RestrictedEnv`'s boundary check would be unreliable —
 * `canonicalPath` returns nothing for a directory that does not exist.
 */
export function sessionWorkDir(sessionId: string, projectFolder?: string | null): string {
  if (projectFolder) {
    mkdirSync(projectFolder, { recursive: true })
    return projectFolder
  }
  return workDir(sessionId)
}

// ---------------------------------------------------------------------------
// Attachments (files and images uploaded to a chat)
// ---------------------------------------------------------------------------
//
// Uploads live INSIDE the work directory — they have to, because the agent
// reads them with the existing `read`/`grep`/`bash` tools and `RestrictedEnv`
// only lets through what is inside the work directory (`environment.ts`).
//
// They are split per session, because in conversations ATTACHED TO A PROJECT
// the work directory is shared (see `sessionWorkDir`) — without the split, the
// files of every conversation in a project would end up mixed in one directory.
//
// `sessiyalar/<sid>/fayllar/` — the per-kind subdirectory is DELIBERATE: in
// future, other session-scoped things (exports, snapshots and so on) get their
// own directory and do not get mixed up with uploads.

/** The root of session-scoped data — relative to the work directory */
export const SESSION_DIR = '.platforma/sessiyalar'

/** The directory for files uploaded within a session */
export const FILES_DIR = 'fayllar'

/**
 * Creates the session's upload directory.
 *
 * `relative` — the path relative to the work directory. This is EXACTLY what
 * is stored in the database and what is handed to the agent: moving a project
 * directory does not break the rows, and the client never sees an absolute
 * path.
 */
export function sessionFilesDir(
  workDirPath: string,
  sessionId: string,
): { full: string; relative: string } {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'
  const relative = join(SESSION_DIR, safeId, FILES_DIR)
  const full = join(workDirPath, relative)
  mkdirSync(full, { recursive: true })
  return { full, relative }
}

/** The maximum length of a file name's stem */
const NAME_MAX = 80

/** The maximum extension length — `.jpeg` and the last part of `.tar.gz` both fit */
const EXTENSION_MAX = 12

/**
 * Turns a user-supplied file name into one safe to write to disk. If nothing
 * usable is left (the name consists entirely of discarded characters) it
 * returns `null` — the caller then supplies a fallback name itself.
 *
 * `projectSlug()` IS NOT REUSED here even though the principle is the same:
 * it turns dots into `-` as well, so `report.pdf` would become `report-pdf`.
 * The extension MATTERS — the agent works out the file type from it, and the
 * `read` tool also looks at it when deciding whether something is an image.
 *
 * THE FILTER WORKS ON THE "ALLOWED CHARACTERS" PRINCIPLE (see the comment on
 * `projectSlug`): only `[a-zA-Z0-9_-]` is kept. That is why no SEPARATE check
 * is needed for `../`, `..\`, NUL, spaces, `;`, `|`, `$`, Cyrillic/emoji or
 * any other path or shell trick — none of them are in the set at all. In other
 * words `"; rm -rf ~; #.png` becomes `rm-rf.png`, free of metacharacters.
 */
export function uploadName(rawName: string | undefined | null): string | null {
  // The type accepts `undefined` as well, because `File.name` is NOT ALWAYS a
  // string: when an image is pasted from the clipboard (the usual case on
  // Windows) the browser sends a nameless `File` and Bun hands it over as
  // `undefined`. In that case the caller supplies a fallback name.
  if (typeof rawName !== 'string') return null

  // Only the last path segment. Both `/` and `\`: the name may come from a
  // Windows client, which sends `C:\Users\...\x.png`.
  const base = rawName.split(/[/\\]/).pop() ?? ''

  // `lastIndexOf('.') > 0` — deliberately `> 0`, not `>= 0`: in a name like
  // `.env` the dot comes first and is not an extension but part of the stem.
  const dot = base.lastIndexOf('.')
  const rawStem = dot > 0 ? base.slice(0, dot) : base
  const rawExtension = dot > 0 ? base.slice(dot + 1) : ''

  const stem = rawStem
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
    // Truncating can leave a dash at the end
    .replace(/-+$/g, '')
  if (!stem) return null

  const extension = rawExtension
    .replace(/[^a-zA-Z0-9]+/g, '')
    .slice(0, EXTENSION_MAX)
    .toLowerCase()

  return extension ? `${stem}.${extension}` : stem
}

/**
 * If the name is taken, appends `-2`, `-3` … until a free one is found.
 *
 * A UUID prefix is DELIBERATELY NOT ADDED: the name is read both by the agent
 * (in the path inside the prompt) and by the user (on the chip) —
 * `a3f9c1-report.pdf` is unrecognisable to both.
 *
 * `existsSync` has a race in it (two files uploaded at the same time) — which
 * is why the caller writes with `flag: 'wx'` and asks again on `EEXIST`.
 */
export function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name

  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''

  // A limit: after 999 we stop and append a timestamp. There must be no
  // infinite loop — if a directory is full of a thousand copies, the problem
  // lies elsewhere.
  for (let i = 2; i <= 999; i += 1) {
    const candidate = `${stem}-${i}${extension}`
    if (!existsSync(join(dir, candidate))) return candidate
  }
  return `${stem}-${Date.now()}${extension}`
}
