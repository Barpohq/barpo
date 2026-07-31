// Shared foundation of the search tools: patterns, limits and the two backends.
//
// There is NO TOOL here — only the pieces `grep`/`find`/`ls` all need:
// glob→regex conversion, directory walking, working-directory boundary
// checking and locating `rg`.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THE MOST IMPORTANT REQUIREMENT: BOTH BACKENDS MUST GIVE THE SAME     │
// │ RESULT.                                                              │
// │                                                                      │
// │ If the agent behaves DIFFERENTLY on a PC that has `rg` and one that  │
// │ does not, that is a silently broken bug: nobody notices, it just     │
// │ turns into "works on my machine, not on yours". That is why every    │
// │ decision below was made on the "identical" criterion, not "faster".  │
// └──────────────────────────────────────────────────────────────────────┘
//
// Three places were identified that could break that sameness, and all
// three were deliberately closed off:
//
//   1) GITIGNORE. `rg` respects `.gitignore` by default, and reproducing
//      that fully in Node (nested `.gitignore`, negation rules `!pattern`,
//      `**` semantics, `.git/info/exclude`, the global gitignore) is a
//      huge surface — a difference would certainly appear somewhere.
//      DECISION: gitignore is NOT READ by EITHER backend (`rg --no-ignore`).
//      In its place stands `SKIPPED_DIRS` below — a strict, short list that
//      is identical on both sides. If the user searches for a file listed
//      in `.gitignore` they will find it; we want that, because the agent
//      very often asks for exactly things like `dist/` or `.env.example`.
//
//   2) ORDER. `rg` walks in parallel and the result order is DIFFERENT ON
//      EVERY RUN (in testing it produced three different orders in three
//      runs). In Node, `readdir` order depends on the file system.
//      DECISION: both backends give the result a final sort with
//      `pathOrder`. `rg` is not given `--sort path` — it disables
//      parallelism and our own sort has the last word anyway.
//
//   3) REGEX DIALECT. `rg`'s Rust engine REJECTS `(?=...)` and `(?<=...)`,
//      whereas JS `RegExp` supports them. That means one and the same
//      pattern could work on one PC and error on another.
//      DECISION: `rg` is given `--pcre2` (the PCRE2 dialect is the closest
//      one to JS). An `rg` built without PCRE2 is not used at all —
//      `rgAvailable()` checks for that and falls back to Node in that case.
//      This way "the set of supported patterns" is the same on both paths.

import { spawn } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

// ---------------------------------------------------------------------------
// Default limits
// ---------------------------------------------------------------------------

/**
 * Directories that are not walked by default.
 *
 * Deliberately SHORT and STRICT: this list stands in for gitignore, so it
 * must be applied EXACTLY the same way in both backends. Every time a new
 * element is added, both `-g '!name'` on the `rg` side and `isSkippedDir()`
 * on the Node side have to change — which is why both read from this one
 * single list.
 *
 * If the user asks for exactly this directory (`path: 'node_modules/x'`) or
 * passes `all: true`, the list is bypassed.
 */
export const SKIPPED_DIRS = [
  '.git',
  // The platform's own territory: skills, memory and session uploads.
  //
  // WHY IT IS SKIPPED. Conversations attached to a project share a single
  // directory (`work-dir.ts`), and uploads live in
  // `.platforma/sessiyalar/<sid>/`. If it were not skipped, an agent `grep`
  // would return results from OTHER conversations' attached files — noise,
  // plus information leaking between conversations.
  //
  // A DELIBERATE SIDE EFFECT: skills (`.platforma/skills`) and memory
  // (`.platforma/memory`) also drop out of search. They land in the prompt
  // in full anyway (`skill-load.ts`, `memory.ts`), so the agent does see
  // them — it just cannot hunt through them with `grep`. The trade is
  // intentional: keeping other conversations' files invisible matters more.
  //
  // Given an explicit path the list is bypassed anyway (see the note above),
  // so the agent can freely read
  // `read('.platforma/sessiyalar/…/fayllar/rasm.png')` — the attachment
  // flow relies on that.
  '.platforma',
  'node_modules',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.venv',
  '__pycache__',
  'target',
  'vendor',
] as const

const SKIPPED_SET: ReadonlySet<string> = new Set(SKIPPED_DIRS)

/** A line longer than this is cut — a minified file must not swamp the result */
export const ROW_LIMIT = 500

/** Default match limit for `grep` */
export const GREP_LIMIT = 200

/** Default file limit for `find` */
export const FIND_LIMIT = 1000

/** Default entry limit for `ls` */
export const LS_LIMIT = 500

/** An external process (`rg`) is stopped once it runs longer than this */
export const PROCESS_TIMEOUT_MS = 30_000

/**
 * Number of bytes inspected when deciding whether a file is binary.
 * `rg` uses a similar heuristic: if there is a NUL byte near the start, the
 * file counts as binary and is excluded from the search.
 */
const BINARY_CHECK_BYTES = 8192

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** A single matching line */
export interface GrepMatch {
  /** Path relative to the working directory — an absolute path NEVER appears */
  path: string
  line: number
  text: string
}

/** A search result — with truncation flagged separately */
export interface SearchResult<T> {
  items: T[]
  /** Whether the limit was reached and the result cut */
  truncated: boolean
  /** Which backend ran — the tests use this to compare the two */
  backend: 'rg' | 'node'
}

/** A single entry for `ls` */
export interface DirEntry {
  name: string
  kind: 'file' | 'dir' | 'symlink'
  /** Bytes — `undefined` for a directory */
  size?: number
}

// ---------------------------------------------------------------------------
// Path boundary
// ---------------------------------------------------------------------------

/**
 * Result of a boundary check.
 *
 * `RestrictedEnv` in `environment.ts` wraps the file operations, but we walk the
 * directory OURSELVES (`rg` does the same), so the boundary is applied
 * separately here. The logic is identical to `RestrictedEnv`'s: both the
 * textual path and the canonical path via `realpath` are checked.
 */
export interface BoundaryResult {
  ok: boolean
  /** The absolute path that passed the check */
  absolute: string
  /** The real path after symlinks are resolved */
  kanonik: string
  /** If not inside — the reason */
  reason?: string
}

/** Is the path inside the `base` directory — at the textual level */
export function isInside(base: string, path: string): boolean {
  return path === base || path.startsWith(base + sep)
}

/**
 * Compares the given path against the working-directory boundary.
 *
 * Two stages — the same ones as in `RestrictedEnv.checkPath`:
 *   1) the textual path (works for a non-existent file too),
 *   2) `realpath` — catches a symlink that sits inside the working
 *      directory but points at /etc.
 *
 * If the symlink does not exist (`realpath` errors) the textual path is
 * considered sufficient: in that case there is no file, so there is nothing
 * to read either.
 */
export async function checkBoundary(
  workDir: string,
  requestedPath: string | undefined,
): Promise<BoundaryResult> {
  const base = resolve(workDir)
  const xom = requestedPath && requestedPath.length > 0 ? requestedPath : '.'
  const absolute = isAbsolute(xom) ? resolve(xom) : resolve(base, xom)

  // Already outside at the textual level — no need to wait for the canonical one
  if (!isInside(base, absolute)) {
    return {
      ok: false,
      absolute,
      kanonik: absolute,
      reason: 'outside the working directory',
    }
  }

  // Escaping through a symlink
  let kanonik = absolute
  try {
    kanonik = await realpath(absolute)
  } catch {
    // The path does not exist — the textual check is sufficient
    return { ok: true, absolute, kanonik: absolute }
  }

  // The working directory itself can be a symlink too (for example
  // /tmp → /private/tmp on macOS). So we compare the base in canonical form
  // as well, otherwise a perfectly valid path would be judged "outside".
  let canonicalBase = base
  try {
    canonicalBase = await realpath(base)
  } catch {
    // The working directory is missing — the check below returns an error anyway
  }

  if (!isInside(canonicalBase, kanonik)) {
    return {
      ok: false,
      absolute,
      kanonik,
      reason: 'the symlink leads outside the working directory',
    }
  }

  return { ok: true, absolute, kanonik }
}

/**
 * Converts an absolute path into a form relative to the working directory.
 *
 * This is not merely cosmetic, it is a SECURITY requirement: absolute paths
 * from outside the working directory must not surface in the result,
 * otherwise the agent (and, through prompt injection, an outside reader)
 * learns the structure of the user's file system.
 */
export function relativePath(workDir: string, absolute: string): string {
  const n = relative(resolve(workDir), absolute)
  return n === '' ? '.' : n
}

// ---------------------------------------------------------------------------
// Ordering — so that both backends produce the same sequence
// ---------------------------------------------------------------------------

/**
 * The sort order for paths.
 *
 * THE MAIN GUARANTEE THAT THE TWO BACKENDS MATCH. `rg` walks in parallel and
 * emits in a random order, Node emits in `readdir` order — neither is
 * reliable. So the result is re-sorted with this function on BOTH paths.
 *
 * Plain `<`/`>` is used, NOT `localeCompare`: `localeCompare` depends on the
 * system locale (under `LANG=tr_TR`, `i`/`I` sort differently), which would
 * be yet another PC-dependent difference. Code-point comparison is the same
 * everywhere.
 */
export function pathOrder(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Order for grep matches: path first, then line number */
export function matchOrder(a: GrepMatch, b: GrepMatch): number {
  const byPath = pathOrder(a.path, b.path)
  return byPath !== 0 ? byPath : a.line - b.line
}

// ---------------------------------------------------------------------------
// Cleaning up a line
// ---------------------------------------------------------------------------

/**
 * Prepares a matching line for the result.
 *
 * `rg` returns the line with its `\n`, whereas in Node we split it
 * ourselves — so that both are identical, a trailing `\r`/`\n` is stripped
 * and the length is cut to the same limit.
 */
export function prepareLine(raw: string): string {
  const clean = raw.replace(/\r?\n$/, '')
  if (clean.length <= ROW_LIMIT) return clean
  return clean.slice(0, ROW_LIMIT) + '…'
}

// ---------------------------------------------------------------------------
// Glob → RegExp
// ---------------------------------------------------------------------------

/**
 * Converts a glob pattern into a regexp.
 *
 * Deliberately matched to `rg`'s glob dialect (the `ignore` crate), because
 * the `find` tool leans on this function on the Node path and on that same
 * crate on the `rg`/`fd` path — the two have to understand things
 * identically:
 *   `*`   — any characters within one segment (does not cross `/`)
 *   `**`  — many segments (crosses `/`)
 *   `?`   — a single character (not `/`)
 *   `[…]` — a character set
 *   `{a,b}` — alternatives
 *
 * If the pattern has no `/` (`*.ts`) it applies ONLY to the file name — this
 * is `rg -g` behaviour too: `-g '*.ts'` also finds `.ts` files in nested
 * directories.
 */
export function globToRegExp(glob: string): RegExp {
  // Does it apply to the name or to the full path
  const appliesToName = !glob.includes('/')
  let re = ''
  let i = 0

  while (i < glob.length) {
    const c = glob[i]!

    if (c === '*') {
      // `**` — crosses segments
      if (glob[i + 1] === '*') {
        // The `**/` form: zero or more segments (`**/a.ts` → `a.ts` matches too)
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 3
          continue
        }
        re += '.*'
        i += 2
        continue
      }
      // A single `*` — does not cross `/`
      re += '[^/]*'
      i += 1
      continue
    }

    if (c === '?') {
      re += '[^/]'
      i += 1
      continue
    }

    // Character set — `]` and `^` inside are passed through as-is
    if (c === '[') {
      const closing = glob.indexOf(']', i + 1)
      if (closing > 0) {
        let inner = glob.slice(i + 1, closing)
        // Negation is `!` in glob, `^` in regexp
        if (inner.startsWith('!')) inner = '^' + inner.slice(1)
        re += '[' + inner + ']'
        i = closing + 1
        continue
      }
      // Unclosed `[` — an ordinary character
      re += '\\['
      i += 1
      continue
    }

    // Alternatives `{a,b}` → `(?:a|b)`
    if (c === '{') {
      const closing = glob.indexOf('}', i + 1)
      if (closing > 0) {
        const alternatives = glob
          .slice(i + 1, closing)
          .split(',')
          .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        re += '(?:' + alternatives.join('|') + ')'
        i = closing + 1
        continue
      }
      re += '\\{'
      i += 1
      continue
    }

    // Everything else — a literal
    re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    i += 1
  }

  return new RegExp('^' + re + '$')
}

/** Does the glob pattern match the path (with the `appliesToName` logic) */
export function globMatches(glob: string, relativePathText: string): boolean {
  const re = globToRegExp(glob)
  if (!glob.includes('/')) {
    // A name-scoped pattern — applied to the last of the segments
    const name = relativePathText.split('/').pop() ?? relativePathText
    return re.test(name)
  }
  return re.test(relativePathText)
}

// ---------------------------------------------------------------------------
// Directory walking (the Node fallback)
// ---------------------------------------------------------------------------

/** Is the directory skipped by default */
export function isSkippedDir(name: string, all: boolean): boolean {
  if (all) return false
  return SKIPPED_SET.has(name)
}

export interface WalkOptions {
  /** The boundary — we never step outside it */
  workDir: string
  /** The directory the walk starts from (absolute, inside the boundary) */
  start: string
  /** Also show the skipped directories */
  all: boolean
  signal?: AbortSignal
}

/**
 * Walks the directory recursively and yields each file's path relative to
 * the working directory.
 *
 * The result comes back SORTED: the entries inside each directory are
 * ordered with `pathOrder`, so that `readdir`'s file-system-dependent order
 * does not leak into the result.
 *
 * Symlinks are NOT FOLLOWED (`lstat` semantics): if a symlink inside the
 * working directory points at /etc, we do not open it and walk it. This is
 * both for security (not leaving the boundary) and for correctness (no
 * infinite loops). `rg` does not follow symlinks by default either — one
 * more piece of sameness.
 */
export async function* walkFiles(
  options: WalkOptions,
): AsyncGenerator<{ relative: string; absolute: string }> {
  const queue: string[] = [options.start]

  while (queue.length > 0) {
    options.signal?.throwIfAborted()
    const dir = queue.shift()!

    // `Dirent[]` is spelled out explicitly: `ReturnType<typeof readdir>`
    // picked the Buffer variant out of the overloads and produced a type error
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Could not read it (no permission, vanished) — we move on silently.
      // `rg` does exactly the same: it writes the error to stderr and continues.
      continue
    }

    // We pin the order RIGHT HERE — `readdir` gives no guarantee
    const sorted = [...entries].sort((a, b) => pathOrder(a.name, b.name))

    const subdirs: string[] = []
    for (const entry of sorted) {
      const absolute = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (isSkippedDir(entry.name, options.all)) continue
        subdirs.push(absolute)
        continue
      }

      // Symlinks and special files (socket, FIFO) — do not count as files
      if (!entry.isFile()) continue

      yield { relative: relativePath(options.workDir, absolute), absolute }
    }

    // We walk breadth-first rather than depth-first, but the subdirectories
    // are not put at the head of the queue — the final sort determines the
    // order anyway, so only determinism matters here.
    queue.push(...subdirs)
  }
}

// ---------------------------------------------------------------------------
// Binary file detection
// ---------------------------------------------------------------------------

/**
 * Is there a NUL among the bytes — the sign of a binary file.
 * `rg` uses this heuristic too, which is why it is used on the Node path as
 * well: otherwise `rg` would skip a PNG file while Node would report a
 * "matching line" out of it.
 */
export function isBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_CHECK_BYTES)
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Locating `rg`
// ---------------------------------------------------------------------------

/**
 * Cache of whether `rg` exists (and is built with PCRE2).
 *
 * `undefined` — not checked yet. The check requires starting a process, so
 * it is done once.
 */
let rgCache: boolean | undefined

/**
 * Clears the cache or forces a value, for tests.
 *
 * Tests have to simulate a PC without `rg` (a requirement of the task),
 * otherwise the tests would take a different path on a machine where `rg`
 * is not installed.
 */
export function setRgCache(value: boolean | undefined): void {
  rgCache = value
}

/**
 * Can `rg` be used.
 *
 * Two conditions: the program MUST exist and it MUST be built with PCRE2.
 *
 * The PCRE2 requirement is deliberately strict. `rg`'s default Rust engine
 * rejects `(?=...)`/`(?<=...)` while JS `RegExp` accepts them — meaning that
 * with a PCRE2-less `rg` one pattern would work while the Node fallback
 * behaved differently (or the other way round). That is exactly the
 * "PC-dependent difference" we are trying to prevent. If PCRE2 is missing,
 * `rg` is not used at all.
 */
export async function rgAvailable(): Promise<boolean> {
  if (rgCache !== undefined) return rgCache
  try {
    const result = await runProcess('rg', ['--version'], { timeoutMs: 5000 })
    rgCache = result.code === 0 && result.stdout.includes('+pcre2')
  } catch {
    rgCache = false
  }
  return rgCache
}

// ---------------------------------------------------------------------------
// Starting a process
// ---------------------------------------------------------------------------

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
  /** Was it stopped because of a timeout or an abort */
  timedOut: boolean
}

export interface ProcessOptions {
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** The process is stopped once the output exceeds this many bytes */
  maxBayt?: number
}

/**
 * Runs an external program.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ NO SHELL IS USED. `spawn(program, args)` — with an argument array,   │
 * │ and NO `shell: true`.                                                │
 * │                                                                      │
 * │ This is required because `pattern` comes from the user (in practice, │
 * │ from the LLM). Passed through a shell, a `grep` pattern such as      │
 * │ `x"; rm -rf ~; echo "` would turn into command injection. In an      │
 * │ argument array the pattern reaches the operating system as RAW       │
 * │ BYTES — there, quotes, `;` and `$` have no special meaning.          │
 * │                                                                      │
 * │ The `command-analysis.ts` check is also DELIBERATELY bypassed here:  │
 * │ the command being run is not LLM text but OUR OWN code — the         │
 * │ program name is hard-coded `'rg'` and the arguments are assembled    │
 * │ in the functions below. Path arguments go through `checkBoundary`.   │
 * └──────────────────────────────────────────────────────────────────────┘
 */
export function runProcess(
  program: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return new Promise((fulfil, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(program, args, {
        cwd: options.cwd,
        // NO shell — see the note above
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const maxBayt = options.maxBayt ?? 32 * 1024 * 1024

    const abort = () => {
      timedOut = true
      child.kill('SIGKILL')
    }

    const timer = setTimeout(abort, options.timeoutMs ?? PROCESS_TIMEOUT_MS)
    const abortListener = () => abort()
    options.signal?.addEventListener('abort', abortListener, { once: true })

    const clear = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abortListener)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length > maxBayt) {
        // The output is far too large — we stop reading so that memory does
        // not fill up. Our own limits (200 matches) kick in well before this
        // anyway.
        abort()
        return
      }
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clear()
      reject(error)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clear()
      fulfil({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

/** Reads the file as bytes; `undefined` on error */
export async function readBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path))
  } catch {
    return undefined
  }
}

/** Gets the file size; `undefined` on error */
export async function readSize(path: string): Promise<number | undefined> {
  try {
    const m = await stat(path)
    return m.size
  } catch {
    return undefined
  }
}
