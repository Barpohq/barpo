// Recognising "the quota ran out" in a provider's error, and working out when
// it lifts.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY THIS IS TEXT MATCHING, WHICH IS NOT THE OBVIOUS DESIGN.          │
// │                                                                      │
// │ The honest way to detect a rate limit is the HTTP layer: status 429  │
// │ and the `retry-after` header. We do not have it. pi-agent-core does  │
// │ not throw on a provider error — it records the reason on the last    │
// │ assistant message as a STRING (`errorMessage`) and returns quietly   │
// │ (see `streamError` in `platform-ai/src/agent.ts`). By the time the   │
// │ orchestrator sees the failure, the response object is long gone.     │
// │                                                                      │
// │ Reaching back for the header would mean threading it through         │
// │ pi-agent-core's stream, which we do not own. So this module reads    │
// │ what we DO have, and is built to fail in the safe direction.         │
// └──────────────────────────────────────────────────────────────────────┘
//
// THE SAFE DIRECTION, PRECISELY. A false negative costs the user one manual
// "carry on" — the error is shown exactly as it is today. A false positive
// silently reschedules a conversation that failed for some other reason, and
// the user is told to wait for a limit that was never hit. So:
//
//   - the phrase must be unambiguous. `429`, "rate limit", "quota exceeded",
//     "usage limit". Not the bare word "limit" — "context length limit" is a
//     different failure with the same word in it.
//   - a recognised limit with NO readable reset time still counts, but falls
//     back to a conservative default rather than guessing a short wait.
//   - anything unrecognised returns `null` and the ordinary error path runs.

/** Added to every reset time — the user's rule: the limit plus five minutes */
export const RESET_MARGIN_MS = 5 * 60 * 1000

/**
 * How long to wait when a limit is recognised but its reset time is not.
 *
 * One hour, because the shortest window any of the subscription plans use is
 * hourly. Waiting too long costs a delayed continuation; waiting too little
 * burns the retry against a limit that has not lifted, and some providers
 * count a rejected request against the quota — which would push the reset
 * further out every time we guessed early.
 */
export const DEFAULT_WAIT_MS = 60 * 60 * 1000

/**
 * The furthest ahead a parsed reset time is trusted.
 *
 * A misread date ("resets 2027-01-01") would park the conversation for a year.
 * Anything beyond a day is treated as a parse failure and falls back to
 * `DEFAULT_WAIT_MS` — no real subscription window is longer than that, and a
 * weekly plan that is genuinely a week out will simply be retried daily until
 * it works.
 */
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000

export interface LimitInfo {
  /** When the limit lifts — epoch ms, INCLUDING the five-minute margin */
  resumeAt: number
  /** Whether a reset time was actually read, or `DEFAULT_WAIT_MS` was used */
  parsed: boolean
  /** The phrase that identified this as a limit — shown in the UI tooltip */
  matched: string
}

/**
 * The phrases that mean "quota", each with the provider wording it comes from.
 *
 * Deliberately not a single clever regex: each entry is separately
 * justifiable, separately testable, and can be removed if a provider changes
 * its wording without disturbing the others.
 */
const LIMIT_PATTERNS: { pattern: RegExp; label: string }[] = [
  // The HTTP status, as it appears inside error strings from most SDKs
  { pattern: /\b429\b/, label: '429' },
  // OpenAI, Anthropic, OpenRouter, Groq — the common phrasing
  { pattern: /\brate[\s_-]?limit/i, label: 'rate limit' },
  // OpenAI: "You exceeded your current quota" / "insufficient_quota".
  // BEFORE the bare `quota` pattern, so the more specific label wins.
  { pattern: /insufficient[\s_-]?quota/i, label: 'insufficient quota' },
  // OpenAI billing, Google AI Studio
  { pattern: /\bquota\b/i, label: 'quota' },
  // Anthropic subscription plans (Claude Pro/Max), Codex
  { pattern: /\busage limit/i, label: 'usage limit' },
  // Anthropic's phrasing when a plan window is exhausted
  { pattern: /\blimit reached\b/i, label: 'limit reached' },
  // "Your limit resets at 3pm" — Claude Code's wording when a plan window is
  // exhausted. The bare word `limit` is too broad to match on its own, but
  // `limit` next to a reset verb is unambiguous: nothing else in an error
  // message talks about a limit that RESETS.
  { pattern: /\blimits?\s+(?:will\s+)?(?:resets?|renews?|refreshes?)/i, label: 'limit resets' },
  // Generic, but only with "exceeded" attached — the bare word is too broad
  { pattern: /\b(?:limit|quota)\s+exceeded\b/i, label: 'limit exceeded' },
  { pattern: /\bexceeded\s+your\s+(?:current\s+)?(?:quota|limit)/i, label: 'exceeded quota' },
  // Anthropic/Claude Code subscription wording
  { pattern: /\bplan\s+limit/i, label: 'plan limit' },
]

/**
 * Phrases that contain a limit word but are NOT a quota problem.
 *
 * Checked FIRST and they win. `context length limit exceeded` matches "limit
 * exceeded" above, and rescheduling it would be actively wrong: the same
 * request will fail identically in an hour, and the conversation would bounce
 * off the same wall once an hour forever.
 */
const NOT_A_QUOTA: RegExp[] = [
  /context[\s_-]?(?:length|window|limit)/i,
  /\bmax(?:imum)?[\s_-]?tokens?\b/i,
  /\btoken[\s_-]?limit\b/i,
  /too many tokens/i,
  /\bcharacter limit\b/i,
  /\bfile size\b/i,
]

/**
 * Reads a provider error and decides whether the conversation should be
 * continued later.
 *
 * Returns `null` when this is not a quota failure — the caller then reports
 * the error as it always has.
 *
 * @param now injected rather than read, so the tests are not time-dependent
 */
export function detectLimit(error: string, now: number = Date.now()): LimitInfo | null {
  if (!error) return null

  // The exclusions win. A context-length error mentions "limit" and would
  // otherwise be rescheduled into an infinite retry loop.
  if (NOT_A_QUOTA.some((p) => p.test(error))) return null

  const hit = LIMIT_PATTERNS.find((p) => p.pattern.test(error))
  if (!hit) return null

  const reset = parseResetTime(error, now)
  // THE WINDOW IS ENFORCED HERE, ON EVERY PATH — not inside the individual
  // parsers. `sane()` guards absolute timestamps, but a DURATION ("retry after
  // 99999999 seconds") arrives as arithmetic on `now` and would sail past it,
  // parking the conversation for three years. One check at the single exit
  // point cannot be forgotten by a parser added later.
  if (reset !== null && reset > now && reset - now <= MAX_WAIT_MS) {
    return { resumeAt: reset + RESET_MARGIN_MS, parsed: true, matched: hit.label }
  }

  return { resumeAt: now + DEFAULT_WAIT_MS + RESET_MARGIN_MS, parsed: false, matched: hit.label }
}

/**
 * Digs a reset time out of the error text. Returns epoch ms, or `null`.
 *
 * The order matters: the most specific and least ambiguous forms are tried
 * first, so a message carrying both a duration and a timestamp uses the
 * timestamp.
 */
function parseResetTime(error: string, now: number): number | null {
  return (
    parseEpoch(error, now) ??
    parseIsoTimestamp(error, now) ??
    parseRetryAfterSeconds(error, now) ??
    parseDuration(error, now) ??
    parseClockTime(error, now)
  )
}

/**
 * A unix timestamp, as Anthropic and OpenAI send in `x-ratelimit-reset` and as
 * Claude Code reports it ("Your limit will reset at 1754038800").
 *
 * SECONDS ARE DISTINGUISHED FROM MILLISECONDS by magnitude: a seconds-epoch
 * for any date this decade is 10 digits, a ms-epoch is 13. Getting this
 * backwards would schedule a run in 1970 or in the year 57000, so both are
 * range-checked against `now` by the caller (`sane`).
 */
function parseEpoch(error: string, now: number): number | null {
  // 13-digit (ms) first — a 13-digit number also contains a valid 10-digit
  // prefix, so testing seconds first would truncate it.
  const ms = error.match(/\b(1[0-9]{12})\b/)
  if (ms) {
    const value = Number(ms[1])
    if (sane(value, now)) return value
  }

  const seconds = error.match(/\b(1[0-9]{9})\b/)
  if (seconds) {
    const value = Number(seconds[1]) * 1000
    if (sane(value, now)) return value
  }

  return null
}

/** An ISO 8601 timestamp — "resets at 2026-08-01T14:30:00Z" */
function parseIsoTimestamp(error: string, now: number): number | null {
  const match = error.match(/\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/)
  if (!match) return null
  const value = Date.parse(match[1]!.replace(' ', 'T'))
  return Number.isNaN(value) || !sane(value, now) ? null : value
}

/**
 * `retry-after`-style seconds, the form SDKs most often paste into the message:
 * "Please retry after 3600 seconds", "retry_after: 42".
 *
 * The unit is REQUIRED (or the `retry-after` key). A bare number in an error
 * string is far more likely to be a model id, a token count or a status code.
 */
function parseRetryAfterSeconds(error: string, now: number): number | null {
  const keyed = error.match(/retry[\s_-]?after["'\s:=]+(\d+(?:\.\d+)?)/i)
  if (keyed) return now + Number(keyed[1]) * 1000

  const worded = error.match(/(?:try again|retry|wait)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(?:s\b|secs?\b|seconds?\b)/i)
  if (worded) return now + Number(worded[1]) * 1000

  return null
}

/**
 * A human-written duration: "try again in 25 minutes", "resets in 2h 30m",
 * "available in 1 hour".
 *
 * Every unit found after the trigger word is summed, so "2h 30m" is 150
 * minutes rather than whichever one matched first.
 */
function parseDuration(error: string, now: number): number | null {
  const trigger = error.match(
    /(?:try again|retry|wait|resets?|available|resumes?|renews?)\s+(?:in|after)?\s*([^.!?\n]{1,40})/i,
  )
  if (!trigger) return null

  const tail = trigger[1]!
  const units: [RegExp, number][] = [
    [/(\d+(?:\.\d+)?)\s*(?:d\b|days?\b)/i, 24 * 60 * 60 * 1000],
    [/(\d+(?:\.\d+)?)\s*(?:h\b|hrs?\b|hours?\b)/i, 60 * 60 * 1000],
    [/(\d+(?:\.\d+)?)\s*(?:m\b|mins?\b|minutes?\b)/i, 60 * 1000],
    [/(\d+(?:\.\d+)?)\s*(?:s\b|secs?\b|seconds?\b)/i, 1000],
  ]

  let total = 0
  for (const [pattern, factor] of units) {
    const found = tail.match(pattern)
    if (found) total += Number(found[1]) * factor
  }

  return total > 0 ? now + total : null
}

/**
 * A wall-clock time with no date — "your limit resets at 3pm", "resets at
 * 14:30". This is how Claude Code words it, so it is worth handling.
 *
 * WHEN THE TIME HAS ALREADY PASSED TODAY it is read as tomorrow. That is the
 * only sensible reading ("resets at 9am" said at 10am cannot mean an hour
 * ago), and it errs toward waiting longer, which is the safe direction.
 */
function parseClockTime(error: string, now: number): number | null {
  const match = error.match(
    /(?:resets?|available|try again|retry|resumes?|renews?)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
  )
  if (!match) return null

  let hour = Number(match[1])
  const minute = match[2] ? Number(match[2]) : 0
  const meridiem = match[3]?.toLowerCase()

  // A bare "resets at 3" with no colon and no am/pm is too weak a signal — it
  // could be a count, a version, anything. Require a real time shape.
  if (!match[2] && !meridiem) return null

  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return null

  const target = new Date(now)
  target.setHours(hour, minute, 0, 0)
  if (target.getTime() <= now) target.setDate(target.getDate() + 1)

  return target.getTime()
}

/**
 * Whether an absolute timestamp is believable: in the future, and not further
 * out than `MAX_WAIT_MS`.
 *
 * This is the guard that keeps a misparsed year from parking a conversation
 * until 2027. A timestamp in the PAST is also rejected — it means we misread
 * the number, and scheduling a run in the past would fire it instantly and
 * straight back into the same limit.
 */
function sane(value: number, now: number): boolean {
  return value > now && value - now <= MAX_WAIT_MS
}

/**
 * The message shown in the chat where the error would have been.
 *
 * `parsed` is surfaced honestly: when the reset time was a guess the user is
 * told so, because "resuming at 15:40" reads as a fact the platform was given,
 * and it was not.
 */
export function limitNotice(info: LimitInfo, locale?: string): string {
  const when = new Date(info.resumeAt).toLocaleString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  })
  return info.parsed
    ? `The provider limit was reached. The conversation continues by itself at ${when}.`
    : `The provider limit was reached. The reset time was not stated, so the conversation ` +
        `will try again at ${when}.`
}
