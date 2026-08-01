// GitHub client — scanning and downloading skill sources.
//
// Two calls are enough:
//   1) `git/trees?recursive=1` — EVERY file in the repo in a single request.
//      We pick the `SKILL.md` files out of it. Asking for each directory
//      separately through the `contents` API would mean dozens of requests
//      (the rate limit would run out fast).
//   2) `tarball` — the whole repo archive at install time. Only the directory
//      we need is extracted; the rest is discarded.
//
// NO AUTHENTICATION: a token is not required for public repositories. Without
// a token the rate limit is 60 requests per hour — enough for a single-user
// platform. When the limit is hit the error is reported CLEARLY (rather than
// silently doing nothing).

const API = 'https://api.github.com'

/** Network request timeout — if GitHub stops responding the session must not hang */
const TIMEOUT_MS = 30_000

/**
 * Tarball size limit. `anthropics/skills` is ~10MB, but an unknown repo can be
 * hundreds of megabytes — loading that into memory would take the server down.
 */
export const MAX_TARBALL_BYTES = 100 * 1024 * 1024

/** Limit for a single skill directory (its final size in the store) */
export const MAX_SKILL_BYTES = 20 * 1024 * 1024

export interface GithubRef {
  owner: string
  repo: string
  /** Empty string = the default branch */
  ref: string
}

/**
 * Extracts a repository reference from text entered by the user.
 *
 * Accepted:
 *   https://github.com/anthropics/skills
 *   https://github.com/anthropics/skills/tree/main
 *   github.com/anthropics/skills.git
 *   anthropics/skills
 *
 * `null` — could not be recognised.
 */
export function parseGithubRef(raw: string): GithubRef | null {
  let text = raw.trim()
  if (!text) return null

  text = text.replace(/^git\+/, '').replace(/\.git$/, '')
  text = text.replace(/^https?:\/\//, '').replace(/^git@github\.com:/, 'github.com/')
  text = text.replace(/^(www\.)?github\.com\//, '')
  text = text.replace(/\/+$/, '')

  const parts = text.split('/').filter(Boolean)
  if (parts.length < 2) return null

  const [owner, repo, ...rest] = parts
  if (!owner || !repo) return null

  // Naming rule: GitHub allows `[A-Za-z0-9._-]`. The dot is needed (names like
  // `repo.js` exist), but a segment consisting ONLY of dots (`.`, `..`) is
  // forbidden — in an API URL it would act as a path segment and shift the
  // request elsewhere (`/repos/../etc` → a different endpoint).
  const validName = (x: string) => /^[A-Za-z0-9._-]+$/.test(x) && !/^\.+$/.test(x)
  if (!validName(owner) || !validName(repo)) return null

  // `/tree/<ref>/...` or `/blob/<ref>/...`
  let ref = ''
  if ((rest[0] === 'tree' || rest[0] === 'blob') && rest[1]) {
    ref = rest.slice(1).join('/')
  }
  // The ref is appended to an API URL (`/commits/<ref>`), so a `..` segment is
  // forbidden — otherwise the path would slide over to a different endpoint
  if (ref) {
    if (!/^[A-Za-z0-9._\/-]+$/.test(ref)) return null
    if (ref.split('/').some((p) => /^\.+$/.test(p))) return null
  }

  return { owner, repo, ref }
}

async function request(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'barpo-skills',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (response.ok) return response

  // Handle the rate limit separately — the user should know what to do next
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get('x-ratelimit-remaining')
    if (remaining === '0') {
      const reset = response.headers.get('x-ratelimit-reset')
      const time = reset
        ? new Date(Number(reset) * 1000).toLocaleTimeString('en-GB')
        : 'a little later'
      throw new Error(`GitHub rate limit reached. Try again at ${time}.`)
    }
  }
  if (response.status === 404) {
    throw new Error('Repository not found. Check the URL (private repositories are not supported).')
  }

  throw new Error(`GitHub error: ${response.status} ${response.statusText}`)
}

/** The repository's default branch and latest commit SHA */
export async function repoInfo(r: GithubRef): Promise<{ ref: string; sha: string }> {
  const ref = r.ref || (await (async () => {
    const response = await request(`${API}/repos/${r.owner}/${r.repo}`)
    const data = (await response.json()) as { default_branch?: string }
    return data.default_branch ?? 'main'
  })())

  const response = await request(
    `${API}/repos/${r.owner}/${r.repo}/commits/${encodeURIComponent(ref)}`,
  )
  const data = (await response.json()) as { sha?: string }
  return { ref, sha: data.sha ?? '' }
}

export interface FoundFile {
  /** Path from the repository root: `document-skills/pdf/SKILL.md` */
  path: string
  /** Blob SHA — used to fetch the contents */
  sha: string
}

/**
 * Finds the files in the repository tree that match a pattern.
 *
 * The whole tree is fetched in a SINGLE CALL (`recursive=1`) and filtered
 * locally — because of the rate limit (60/hour, unauthenticated) we cannot
 * send a separate request per directory.
 *
 * The `truncated` flag: for a very large repository GitHub cuts the tree
 * short. In that case we return what was found and hand the caller a warning —
 * a partial result is more useful than an empty one.
 *
 * THE PATTERN IS A PARAMETER: skills look for `SKILL.md`, the MCP marketplace
 * for `server.json`. Both need the same tree request and the same `truncated`
 * handling, so only the filter was lifted out.
 */
export async function findFiles(
  r: GithubRef,
  ref: string,
  pattern: RegExp,
): Promise<{ files: FoundFile[]; truncated: boolean }> {
  const response = await request(
    `${API}/repos/${r.owner}/${r.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  )
  const data = (await response.json()) as {
    tree?: { path?: string; type?: string; sha?: string }[]
    truncated?: boolean
  }

  const files: FoundFile[] = []
  for (const entry of data.tree ?? []) {
    if (entry.type !== 'blob' || !entry.path || !entry.sha) continue
    if (!pattern.test(entry.path)) continue
    files.push({ path: entry.path, sha: entry.sha })
  }

  return { files, truncated: data.truncated === true }
}

/** A `SKILL.md` inside a directory or at the root (case-insensitive) */
const SKILL_PATTERN = /(^|\/)SKILL\.md$/i

/** Finds every `SKILL.md` path in the repository */
export async function findSkillFiles(
  r: GithubRef,
  ref: string,
): Promise<{ files: FoundFile[]; truncated: boolean }> {
  return findFiles(r, ref, SKILL_PATTERN)
}

/** A single blob's contents — for the `SKILL.md` frontmatter during a catalog scan */
export async function readBlob(r: GithubRef, sha: string): Promise<string> {
  const response = await request(`${API}/repos/${r.owner}/${r.repo}/git/blobs/${sha}`)
  const data = (await response.json()) as { content?: string; encoding?: string }
  if (data.encoding !== 'base64' || !data.content) return ''
  return Buffer.from(data.content, 'base64').toString('utf8')
}

/**
 * Downloads the repository tarball (already gunzipped).
 *
 * The size is checked twice: up front from the `Content-Length` header, and
 * again after the download from the actual size — the header can lie.
 */
export async function fetchTarball(r: GithubRef, ref: string): Promise<Uint8Array> {
  const response = await fetch(
    `https://codeload.github.com/${r.owner}/${r.repo}/tar.gz/${encodeURIComponent(ref)}`,
    {
      headers: { 'User-Agent': 'barpo-skills' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  )

  if (!response.ok) {
    throw new Error(`Could not download the archive: ${response.status} ${response.statusText}`)
  }

  const length = response.headers.get('content-length')
  if (length && Number(length) > MAX_TARBALL_BYTES) {
    throw new Error(`Repository too large (${Math.round(Number(length) / 1024 / 1024)}MB)`)
  }

  const compressed = new Uint8Array(await response.arrayBuffer())
  if (compressed.length > MAX_TARBALL_BYTES) {
    throw new Error('Repository too large')
  }

  return Bun.gunzipSync(compressed)
}
