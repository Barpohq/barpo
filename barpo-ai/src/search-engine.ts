// The search engines: two backends each for `grep`, `find` and `ls`.
//
// For every operation there are two functions — `...Rg()` and `...Node()` —
// and a single selector (`grepSearch`, `findSearch`, `lsList`) calls one of
// them depending on whether `rg` is present.
//
// THE TWO MUST RETURN THE SAME RESULT. This is not merely an intention, it
// is enforced by a test: `search-parity.test.ts` calls both functions
// SEPARATELY for the same input and compares the results (including their
// order).
//
// The decisions taken to ensure that sameness are written out in detail in
// the comment at the top of `search-core.ts`. In brief:
//   gitignore — NOT READ by either (`--no-ignore` + a strict list)
//   order     — both are sorted with `pathOrder`/`matchOrder`
//   regex     — `rg --pcre2`; an `rg` without PCRE2 is not used
//   symlink   — followed by neither
//   binary    — skipped by both, via the NUL byte heuristic
//
// `rg` is not used for `ls` — it is a search program, not a directory
// lister. `fd` is not used for `find` either: on this system it goes by the
// name `fdfind` (Debian), elsewhere `fd`, and on a third machine it is
// absent entirely — that is, yet another source of "PC-dependent
// difference". `rg --files` is used instead: it comes with `rg` itself, its
// glob filter leans on the same `ignore` crate, and it shares one program
// with `grep`.

import {
  readBytes,
  checkBoundary,
  walkFiles,
  FIND_LIMIT,
  globMatches,
  GREP_LIMIT,
  isBinary,
  runProcess,
  LS_LIMIT,
  matchOrder,
  relativePath,
  readSize,
  isSkippedDir,
  prepareLine,
  rgAvailable,
  SKIPPED_DIRS,
  pathOrder,
  type GrepMatch,
  type DirEntry,
  type SearchResult,
} from './search-core.ts'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Error thrown for a path outside the boundary */
export class BoundaryError extends Error {
  constructor(path: string, reason: string) {
    super(`Permission denied: ${path} — ${reason}`)
    this.name = 'BoundaryError'
  }
}

/** Error thrown when the pattern is invalid */
export class PatternError extends Error {
  constructor(pattern: string, reason: string) {
    super(`Invalid pattern \`${pattern}\`: ${reason}`)
    this.name = 'PatternError'
  }
}

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

export interface GrepOptions {
  workDir: string
  pattern: string
  /** Directory or file to search — default: the working directory */
  path?: string
  /** File name filter (glob) */
  glob?: string
  caseInsensitive?: boolean
  /** Also search the skipped directories */
  all?: boolean
  limit?: number
  signal?: AbortSignal
}

export interface FindOptions {
  workDir: string
  /** Glob pattern */
  pattern: string
  path?: string
  all?: boolean
  limit?: number
  signal?: AbortSignal
}

export interface LsOptions {
  workDir: string
  path?: string
  all?: boolean
  limit?: number
  signal?: AbortSignal
}

/**
 * Validates the pattern as a JS `RegExp`.
 *
 * It is called on the `rg` path too — even though `rg` performs the search
 * there. The reason: a pattern error must surface at the SAME moment and
 * with the same message on BOTH backends. Otherwise a PC with `rg` would
 * show a PCRE2 message and a PC without `rg` a V8 message — another
 * difference.
 */
function validatePattern(pattern: string, caseInsensitive: boolean): RegExp {
  if (pattern.length === 0) {
    throw new PatternError(pattern, 'the pattern is empty')
  }
  try {
    return new RegExp(pattern, caseInsensitive ? 'i' : '')
  } catch (error) {
    throw new PatternError(pattern, error instanceof Error ? error.message : String(error))
  }
}

/** Checks the boundary and throws if it is not passed */
async function boundaryOrThrow(workDir: string, path: string | undefined): Promise<string> {
  const result = await checkBoundary(workDir, path)
  if (!result.ok) {
    // The error message uses the RELATIVE path — if an absolute path leaked
    // out, the file system structure would be disclosed
    throw new BoundaryError(path ?? '.', result.reason ?? 'outside the allowed boundary')
  }
  return result.absolute
}

/**
 * Is the path the user asked for itself inside a skipped directory.
 *
 * If the agent explicitly asks for `node_modules/package`, we have to show
 * it — "skip by default" applies only WHILE WALKING, not to an explicit
 * request. The same rule holds in both backends.
 */
function explicitlyRequested(workDir: string, absolute: string): boolean {
  const relative = relativePath(workDir, absolute)
  if (relative === '.') return false
  return relative.split('/').some((segment) => (SKIPPED_DIRS as readonly string[]).includes(segment))
}

// ===========================================================================
// grep
// ===========================================================================

/**
 * The `rg` backend.
 *
 * The flags were chosen for sameness:
 *   --no-ignore  do not read gitignore (the Node fallback does not either)
 *   --hidden     show hidden files (Node shows them too)
 *   --pcre2      the dialect closest to JS `RegExp`
 *   --no-config  so the user cannot add flags via `RIPGREP_CONFIG_PATH` and
 *                change the result — this was the subtlest place capable of
 *                producing a silent difference
 *   --line-number, --no-heading, --with-filename — the `file:line:text` form
 *   -g '!name'   the skipped directories (from the same list as Node)
 */
export async function grepRg(options: GrepOptions): Promise<SearchResult<GrepMatch>> {
  const limit = options.limit ?? GREP_LIMIT
  const absolute = await boundaryOrThrow(options.workDir, options.path)
  validatePattern(options.pattern, options.caseInsensitive ?? false)

  const all = options.all ?? explicitlyRequested(options.workDir, absolute)

  const args = [
    '--no-config',
    '--no-ignore',
    '--hidden',
    '--pcre2',
    '--line-number',
    '--no-heading',
    '--with-filename',
    '--color=never',
    // Symlinks are not followed — the Node fallback does not follow them
    // either (this is the default behaviour, spelled out for clarity)
    '--no-follow',
  ]

  if (options.caseInsensitive) args.push('--ignore-case')
  if (options.glob) args.push('--glob', options.glob)
  if (!all) {
    for (const dir of SKIPPED_DIRS) args.push('--glob', `!${dir}`)
  }

  // The pattern goes after `--`: a pattern starting with `-` must not be
  // read as a flag. `-e` does the same job, but the two together are more
  // reliable.
  args.push('-e', options.pattern, '--', '.')

  const result = await runProcess('rg', args, {
    cwd: absolute,
    signal: options.signal,
  })

  // rg: 0 — found, 1 — not found (not an error), 2 — a real error
  if (result.code === 1 && result.stdout.length === 0) {
    return { items: [], truncated: false, backend: 'rg' }
  }
  if (result.code !== 0 && result.code !== 1 && !result.timedOut) {
    throw new Error(`rg error (${result.code}): ${result.stderr.trim().slice(0, 300)}`)
  }

  const matches: GrepMatch[] = []
  for (const line of result.stdout.split('\n')) {
    if (!line) continue
    // The form is `./path/file.ts:12:text` — the path can contain `:` too,
    // so we split twice from the left and check that the middle piece is a
    // number.
    const parsed = parseRgLine(line)
    if (!parsed) continue

    // `rg` gives `./x` relative to `cwd`; we convert it to a form relative
    // to the working directory — the Node fallback returns it that way too
    const absoluteFile = join(absolute, parsed.path)
    matches.push({
      path: relativePath(options.workDir, absoluteFile),
      line: parsed.line,
      text: prepareLine(parsed.text),
    })
  }

  return capAndSort(matches, limit, 'rg')
}

/** Parses the `./path:12:text` form */
function parseRgLine(line: string): { path: string; line: number; text: string } | undefined {
  // The path can contain `:` (`a:b.ts:12:text`), so we do not search from
  // the left — after each `:` we test whether a number and another `:`
  // follow.
  let searchFrom = 0
  while (true) {
    const first = line.indexOf(':', searchFrom)
    if (first < 0) return undefined
    const second = line.indexOf(':', first + 1)
    if (second < 0) return undefined

    const numberText = line.slice(first + 1, second)
    if (/^\d+$/.test(numberText)) {
      let path = line.slice(0, first)
      if (path.startsWith('./')) path = path.slice(2)
      return { path, line: Number(numberText), text: line.slice(second + 1) }
    }
    searchFrom = first + 1
  }
}

/**
 * The pure Node backend.
 *
 * Deliberately built this way so that it matches `rg`:
 *   - gitignore is not read (per the decision above)
 *   - hidden files are searched
 *   - binary files are skipped (the NUL byte heuristic)
 *   - symlinks are not followed
 *   - the result is sorted with `matchOrder`
 */
export async function grepNode(options: GrepOptions): Promise<SearchResult<GrepMatch>> {
  const limit = options.limit ?? GREP_LIMIT
  const absolute = await boundaryOrThrow(options.workDir, options.path)
  const pattern = validatePattern(options.pattern, options.caseInsensitive ?? false)

  const all = options.all ?? explicitlyRequested(options.workDir, absolute)
  const matches: GrepMatch[] = []

  for await (const file of walkFiles({
    workDir: options.workDir,
    start: absolute,
    all,
    signal: options.signal,
  })) {
    // The glob filter — applied to the path relative to `absolute`, because
    // `rg` also applies the glob relative to the directory it is searching
    if (options.glob) {
      const relativeToDir = relativePath(absolute, file.absolute)
      if (!globMatches(options.glob, relativeToDir)) continue
    }

    const bytes = await readBytes(file.absolute)
    if (!bytes) continue
    // A binary file — `rg` skips it, and so do we
    if (isBinary(bytes)) continue

    // `fatal: false` — invalid UTF-8 bytes become `` instead of throwing.
    // `rg` does the same: it does not discard a badly encoded file
    // entirely, it searches the part it could read.
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const lines = text.split('\n')

    for (let i = 0; i < lines.length; i += 1) {
      // If the last element is the empty piece after a `\n` — it is not a line
      if (i === lines.length - 1 && lines[i] === '') break

      // The `g` flag is not used, to avoid the `lastIndex` problem
      if (!pattern.test(lines[i]!)) continue
      matches.push({
        path: file.relative,
        line: i + 1,
        text: prepareLine(lines[i]!),
      })
    }
  }

  return capAndSort(matches, limit, 'node')
}

/**
 * Sorts, then cuts to the limit.
 *
 * The cut happens AFTER the sort — this matters: if we cut first and sorted
 * afterwards, `rg`'s random order would make the two backends pick a
 * DIFFERENT set of 200. As it is, both give "the first 200" in the same
 * order.
 */
function capAndSort(
  matches: GrepMatch[],
  limit: number,
  backend: 'rg' | 'node',
): SearchResult<GrepMatch> {
  matches.sort(matchOrder)
  const truncated = matches.length > limit
  return { items: truncated ? matches.slice(0, limit) : matches, truncated, backend }
}

/** Uses `rg` if available, otherwise the Node fallback */
export async function grepSearch(options: GrepOptions): Promise<SearchResult<GrepMatch>> {
  return (await rgAvailable()) ? grepRg(options) : grepNode(options)
}

// ===========================================================================
// find
// ===========================================================================

/**
 * The `rg --files` backend.
 *
 * `fd` is DELIBERATELY not used: on this system it is `fdfind` (Debian), on
 * another distribution `fd`, and on many PCs absent entirely. Handling three
 * cases means three possible behavioural differences. `rg --files`, by
 * contrast, comes with `rg` itself and leans on one flag set and one glob
 * crate together with `grep`.
 */
export async function findRg(options: FindOptions): Promise<SearchResult<string>> {
  const limit = options.limit ?? FIND_LIMIT
  const absolute = await boundaryOrThrow(options.workDir, options.path)
  const all = options.all ?? explicitlyRequested(options.workDir, absolute)

  const args = ['--no-config', '--no-ignore', '--hidden', '--no-follow', '--files']
  if (options.pattern) args.push('--glob', options.pattern)
  if (!all) {
    for (const dir of SKIPPED_DIRS) args.push('--glob', `!${dir}`)
  }
  args.push('--', '.')

  const result = await runProcess('rg', args, {
    cwd: absolute,
    signal: options.signal,
  })

  if (result.code !== 0 && result.code !== 1 && !result.timedOut) {
    throw new Error(`rg error (${result.code}): ${result.stderr.trim().slice(0, 300)}`)
  }

  const paths: string[] = []
  for (const line of result.stdout.split('\n')) {
    if (!line) continue
    const clean = line.startsWith('./') ? line.slice(2) : line
    paths.push(relativePath(options.workDir, join(absolute, clean)))
  }

  return capPaths(paths, limit, 'rg')
}

/** The pure Node backend — `walkFiles` + `globMatches` */
export async function findNode(options: FindOptions): Promise<SearchResult<string>> {
  const limit = options.limit ?? FIND_LIMIT
  const absolute = await boundaryOrThrow(options.workDir, options.path)
  const all = options.all ?? explicitlyRequested(options.workDir, absolute)

  const paths: string[] = []
  for await (const file of walkFiles({
    workDir: options.workDir,
    start: absolute,
    all,
    signal: options.signal,
  })) {
    if (options.pattern) {
      const relativeToDir = relativePath(absolute, file.absolute)
      if (!globMatches(options.pattern, relativeToDir)) continue
    }
    paths.push(file.relative)
  }

  return capPaths(paths, limit, 'node')
}

function capPaths(
  paths: string[],
  limit: number,
  backend: 'rg' | 'node',
): SearchResult<string> {
  paths.sort(pathOrder)
  const truncated = paths.length > limit
  return { items: truncated ? paths.slice(0, limit) : paths, truncated, backend }
}

export async function findSearch(options: FindOptions): Promise<SearchResult<string>> {
  return (await rgAvailable()) ? findRg(options) : findNode(options)
}

// ===========================================================================
// ls
// ===========================================================================

/**
 * Directory listing — Node only.
 *
 * There is NO second backend here, and there need not be one: `ls` does not
 * lean on an external program, so the "PC-dependent difference" source never
 * arises at all. The backend field still comes back as `'node'`, so the
 * result shape stays the same as for the other two tools.
 */
export async function lsList(options: LsOptions): Promise<SearchResult<DirEntry>> {
  const limit = options.limit ?? LS_LIMIT
  const absolute = await boundaryOrThrow(options.workDir, options.path)
  const all = options.all ?? explicitlyRequested(options.workDir, absolute)

  // `Dirent[]` is spelled out explicitly — `ReturnType<typeof readdir>`
  // would have picked the Buffer variant out of the overloads
  let raw: Dirent[]
  try {
    raw = await readdir(absolute, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOTDIR') throw new Error(`Not a directory: ${relativePath(options.workDir, absolute)}`)
    if (code === 'ENOENT') throw new Error(`Not found: ${relativePath(options.workDir, absolute)}`)
    throw new Error(`Could not read: ${relativePath(options.workDir, absolute)}`)
  }

  const items: DirEntry[] = []
  for (const entry of raw) {
    if (entry.isDirectory() && isSkippedDir(entry.name, all)) continue

    const kind: DirEntry['kind'] = entry.isDirectory()
      ? 'dir'
      : entry.isSymbolicLink()
        ? 'symlink'
        : 'file'

    items.push({
      name: entry.name,
      kind,
      // A directory's size is meaningless (file system metadata), we do not show it
      size: kind === 'file' ? await readSize(join(absolute, entry.name)) : undefined,
    })
  }

  // Directories first, then files — within each group, by name.
  // This is the customary `ls` presentation and is easy for the agent to read.
  items.sort((a, b) => {
    const aIsDir = a.kind === 'dir' ? 0 : 1
    const bIsDir = b.kind === 'dir' ? 0 : 1
    if (aIsDir !== bIsDir) return aIsDir - bIsDir
    return pathOrder(a.name, b.name)
  })

  const truncated = items.length > limit
  return {
    items: truncated ? items.slice(0, limit) : items,
    truncated,
    backend: 'node',
  }
}
