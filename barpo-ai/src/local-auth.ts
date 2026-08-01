// READING (not writing) the OAuth tokens of other programs on the PC.
//
// Claude Code stores its subscription token in `~/.claude/.credentials.json`,
// Codex CLI in `~/.codex/auth.json`. pi-ai does not know about these files —
// we read them and hand them to its CredentialStore in the shape
// `{type:'oauth', access, refresh, expires}`, after which pi-ai keeps the
// token refreshed itself.
//
// IMPORTANT: these files belong to other programs and their format is not
// agreed with anyone — it may change in any version. That is why this module
// NEVER throws: when it sees an unexpected shape it returns `undefined` and
// the cause comes back in the `reason` field. The provider simply does not
// appear in the list, and everything else keeps working.
//
// The token itself is never logged anywhere.

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OAuthCredential } from '@earendil-works/pi-ai'

export interface LocalAuthFound {
  /** pi-ai provider id: 'anthropic' or 'openai-codex' */
  providerId: string
  /** The source name shown to the user */
  source: string
  credential: OAuthCredential
}

export interface LocalAuthResult {
  found?: LocalAuthFound
  /** If nothing was found — why (for logs and diagnostics, no secrets) */
  reason?: string
}

/** Looks for the first matching OAuth triple in an object of arbitrary depth */
function findToken(value: unknown, depth = 0): OAuthCredential | undefined {
  if (depth > 3 || typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>

  // Different programs name them differently — we try every known variant
  const access = firstString(o, ['accessToken', 'access_token', 'access'])
  const refresh = firstString(o, ['refreshToken', 'refresh_token', 'refresh'])
  const expiry = firstNumber(o, ['expiresAt', 'expires_at', 'expires', 'expiresIn', 'expires_in'])

  if (access && refresh) {
    // Codex does not keep the expiry in a separate field in
    // `~/.codex/auth.json` — it only sits inside the JWT (`exp`). An explicit
    // field wins when present, otherwise we open up the access_token. Without
    // that the expiry would stay 0 and pi-ai would refresh a token still valid
    // for 10 days on every startup — while OpenAI rotates the token on refresh
    // and revokes the old one.
    const expires = expiry !== undefined ? normalizeExpiry(expiry) : jwtExpiry(access)

    return { type: 'oauth', access, refresh, expires }
  }

  // Nothing found on the top level — we look at the nested objects
  // (for example {"claudeAiOauth": {...}} or {"tokens": {...}})
  for (const nested of Object.values(o)) {
    const found = findToken(nested, depth + 1)
    if (found) return found
  }
  return undefined
}

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function firstNumber(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      // It may also be an ISO date
      const date = Date.parse(v)
      if (!Number.isNaN(date)) return date
    }
  }
  return undefined
}

/**
 * Returns the `exp` claim of the JWT payload as an absolute time in
 * milliseconds. If the token is not a JWT or `exp` is not found — 0 (expiry
 * unknown, pi-ai will refresh it).
 *
 * The signature is NOT VERIFIED: this token does not belong to us and we only
 * pass it on to our own server. The one thing we need from it is a hint about
 * when to refresh. Even if the signature is invalid, OpenAI will reject it
 * itself.
 */
function jwtExpiry(token: string): number {
  const parts = token.split('.')
  if (parts.length !== 3) return 0
  try {
    const payload = parts[1] ?? ''
    // JWT uses base64url; atob expects standard base64
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    const claims = JSON.parse(atob(padded)) as unknown
    if (typeof claims !== 'object' || claims === null) return 0
    const exp = (claims as Record<string, unknown>).exp
    // Per RFC 7519 `exp` is always a Unix time in seconds
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return 0
    return exp * 1000
  } catch {
    // Broken base64 or JSON — expiry unknown
    return 0
  }
}

/**
 * Brings the expiry to an absolute time in milliseconds.
 * Various formats occur: absolute ms, absolute seconds, or seconds remaining.
 */
function normalizeExpiry(value: number | undefined): number {
  if (value === undefined) return 0

  const now = Date.now()
  // Greater than 10^12 — an absolute time in milliseconds
  if (value > 1e12) return value
  // Greater than 10^9 — an absolute time in seconds (after the year 2001)
  if (value > 1e9) return value * 1000
  // A small number — "expires in this many seconds"; the start time is
  // unknown, so we treat it as already expired (pi-ai will refresh it)
  if (value > 0) return now + value * 1000
  return 0
}

async function readJson(path: string): Promise<{ value?: unknown; reason?: string }> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return { reason: 'file not found' }
    return { value: JSON.parse(await file.text()) as unknown }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The file itself is secret — we return only the kind of error, not its content
    return { reason: `could not be read (${message.slice(0, 80)})` }
  }
}

/** Reads the Claude Code (Claude Pro/Max subscription) token */
export async function claudeCodeAuth(home = homedir()): Promise<LocalAuthResult> {
  const path = join(home, '.claude', '.credentials.json')
  const { value, reason } = await readJson(path)
  if (reason) return { reason: `~/.claude/.credentials.json — ${reason}` }

  const credential = findToken(value)
  if (!credential) {
    return { reason: '~/.claude/.credentials.json — OAuth token shape not recognised' }
  }

  return {
    found: { providerId: 'anthropic', source: '~/.claude (Claude subscription)', credential },
  }
}

/** Reads the Codex CLI (ChatGPT Plus/Pro subscription) token */
export async function codexAuth(home = homedir()): Promise<LocalAuthResult> {
  const path = join(home, '.codex', 'auth.json')
  const { value, reason } = await readJson(path)
  if (reason) return { reason: `~/.codex/auth.json — ${reason}` }

  const credential = findToken(value)
  if (!credential) return { reason: '~/.codex/auth.json — OAuth token shape not recognised' }

  return {
    found: { providerId: 'openai-codex', source: '~/.codex (ChatGPT subscription)', credential },
  }
}

/** Checks both sources */
export async function localAuths(home = homedir()): Promise<LocalAuthResult[]> {
  return Promise.all([claudeCodeAuth(home), codexAuth(home)])
}
