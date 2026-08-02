// Presence — the OTHER conversations working in the same project directory.
//
// Every chat attached to a project shares ONE working directory
// (`work-dir.ts` in barpo-server). Until now each agent worked as if it were
// alone there: a second conversation could be editing the same file at the
// same moment, and neither knew. This module is the "knowing" half of the
// fix — the agent is TOLD who else is there, and the rules tell it how to
// behave in a shared directory. It is presence, not isolation: nothing here
// prevents a collision, it makes the agent aware of the possibility.
//
// The data comes from the SERVER (the session table and the running-stream
// registry live in barpo-server) — the same inversion as `serverProvider` /
// `scheduleSink`: the server gathers, this module only formats. This is the
// first prompt input that does NOT come from the working directory.
//
// SECURITY: a session title is user-supplied or model-generated text — the
// same class of untrusted input as a skill description. It is escaped and
// capped here, and like every untrusted prompt input it NEVER REACHES THE
// CLASSIFIER (a test enforces it).

/** One sibling conversation, as the server reports it. */
export interface Sibling {
  title: string
  /** Whether that session has a stream in flight right now */
  streaming: boolean
  /** ISO timestamp of its last activity */
  updatedAt: string
}

/** A title longer than this is noise in a prompt line. */
const TITLE_LIMIT = 80

/** The list is capped by the server query; this is a formatting backstop. */
const SIBLING_LIMIT = 20

/**
 * A title goes into the prompt inside quotes, on one line. Control
 * characters and newlines are stripped so a crafted title cannot forge a
 * section header or extra list entries; the quote it sits in is closed by
 * us, so quotes inside are just characters.
 */
function cleanTitle(title: string): string {
  const t = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
  const cut = t.slice(0, TITLE_LIMIT)
  return cut.length > 0 ? (cut.length < t.length ? `${cut}…` : cut) : '(untitled)'
}

/** "working right now" / "last active 12 minutes ago" — relative, not a timestamp. */
function activity(sibling: Sibling, now: number): string {
  if (sibling.streaming) return 'working right now'
  const ms = now - Date.parse(sibling.updatedAt)
  if (!Number.isFinite(ms) || ms < 0) return 'last active recently'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'last active moments ago'
  if (minutes < 60) return `last active ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `last active ${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `last active ${days} days ago`
}

/**
 * The prompt section. `null` on an empty list — a conversation with no
 * project, or the only conversation of its project, never hears a word
 * about the mechanism (the same rule as `skillsToPrompt`).
 *
 * `now` is a parameter so tests can pin the clock.
 */
export function presenceToPrompt(siblings: Sibling[], now: number = Date.now()): string | null {
  if (siblings.length === 0) return null

  const lines = [
    '',
    '--- Other conversations in this project ---',
    'This working directory is SHARED. These other conversations are open on',
    'the same files:',
    '',
  ]
  for (const s of siblings.slice(0, SIBLING_LIMIT)) {
    lines.push(`- "${cleanTitle(s.title)}" — ${activity(s, now)}`)
  }
  lines.push(
    '',
    'This list was taken when your turn started and may already be out of',
    'date. Files can change under you while you work: if something you read',
    'does not match what you expect, read it again rather than assuming. Do',
    'not undo or "tidy up" work you did not do — it probably belongs to one of',
    'these. When another conversation is working right now, keep away from the',
    'files it is likely to be touching, and if the user\'s request overlaps',
    'with it, say so.',
  )
  return lines.join('\n')
}
