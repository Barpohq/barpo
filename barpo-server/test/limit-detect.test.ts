// Recognising a quota failure in a provider's error string.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THE TWO FAILURE MODES ARE NOT SYMMETRIC, AND THE TESTS REFLECT THAT. │
// │                                                                      │
// │ A false negative costs one manual "carry on" — the user sees the     │
// │ error exactly as they do today.                                      │
// │                                                                      │
// │ A false positive is worse: a conversation that failed for some other │
// │ reason gets parked, and the user is told to wait for a limit that    │
// │ was never hit. Worse still for a context-length error, which will    │
// │ fail identically on every retry — an infinite hourly loop.           │
// │                                                                      │
// │ So the "must NOT match" block below is the more important half of    │
// │ this file.                                                           │
// └──────────────────────────────────────────────────────────────────────┘
//
// `now` is injected everywhere, so nothing here depends on the wall clock.

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_WAIT_MS,
  MAX_WAIT_MS,
  RESET_MARGIN_MS,
  detectLimit,
  limitNotice,
} from '../src/schedule/limit-detect.ts'

/** A fixed "now": 2026-08-01 12:00 local time */
const NOW = new Date(2026, 7, 1, 12, 0, 0, 0).getTime()

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

// ===========================================================================
// What counts as a limit
// ===========================================================================

describe('detectLimit — the phrases that mean "quota"', () => {
  // Each of these is a real provider wording; the label records which.
  const recognised: [string, string, string][] = [
    ['429', 'Request failed with status code 429', '429'],
    ['rate limit', 'Rate limit reached for gpt-4 in organization org-x', 'rate limit'],
    ['rate_limit', 'error: rate_limit_error', 'rate limit'],
    ['quota', 'You exceeded your current quota, please check your plan', 'quota'],
    ['usage limit', 'Claude usage limit reached', 'usage limit'],
    ['insufficient_quota', 'insufficient_quota: billing hard limit reached', 'insufficient quota'],
    ['plan limit', 'You have hit your plan limit for this week', 'plan limit'],
    ['limit exceeded', 'Monthly limit exceeded for this API key', 'limit exceeded'],
  ]

  for (const [name, message, label] of recognised) {
    test(`recognises ${name}`, () => {
      const info = detectLimit(message, NOW)
      expect(info).not.toBeNull()
      expect(info!.matched).toBe(label)
    })
  }

  test('an empty or unrelated error is not a limit', () => {
    expect(detectLimit('', NOW)).toBeNull()
    expect(detectLimit('Connection reset by peer', NOW)).toBeNull()
    expect(detectLimit('invalidated oauth token', NOW)).toBeNull()
    expect(detectLimit('400 Reasoning is mandatory for this endpoint', NOW)).toBeNull()
    expect(detectLimit('The model produced an invalid tool call', NOW)).toBeNull()
  })
})

describe('detectLimit — what must NOT be treated as a quota', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // The most important block in the file. Every one of these contains a word
  // that appears in the patterns, and rescheduling any of them would put the
  // conversation into a retry loop against a wall that does not move.
  // ─────────────────────────────────────────────────────────────────────────

  test('a context-length failure is not a quota failure', () => {
    // It matches "limit exceeded", but the same request fails identically in
    // an hour — this would bounce off the same wall once an hour forever.
    expect(detectLimit('This model\'s maximum context length is 8192 tokens', NOW)).toBeNull()
    expect(detectLimit('context_length_exceeded: limit exceeded', NOW)).toBeNull()
    expect(detectLimit('Context window limit reached for this conversation', NOW)).toBeNull()
  })

  test('a token-count failure is not a quota failure', () => {
    expect(detectLimit('max_tokens must be less than 4096', NOW)).toBeNull()
    expect(detectLimit('Token limit reached for this request', NOW)).toBeNull()
    expect(detectLimit('too many tokens in the prompt', NOW)).toBeNull()
  })

  test('size limits are not quota failures', () => {
    expect(detectLimit('character limit exceeded in field "name"', NOW)).toBeNull()
    expect(detectLimit('file size limit exceeded', NOW)).toBeNull()
  })

  test('the bare word "limit" is not enough on its own', () => {
    // Otherwise every error mentioning a limit of any kind would reschedule.
    expect(detectLimit('The limit parameter must be a positive integer', NOW)).toBeNull()
    expect(detectLimit('No limit was specified', NOW)).toBeNull()
  })

  test('an exclusion wins even when a genuine limit phrase is also present', () => {
    // Deliberate: when the message is ambiguous, NOT rescheduling is the safe
    // half. The user still sees the full error and can act on it.
    expect(detectLimit('429: maximum context length exceeded', NOW)).toBeNull()
  })
})

// ===========================================================================
// Reading the reset time
// ===========================================================================

describe('detectLimit — reset time from a duration', () => {
  test('seconds via retry-after', () => {
    const info = detectLimit('Rate limit reached. Please retry after 3600 seconds', NOW)!
    expect(info.parsed).toBe(true)
    expect(info.resumeAt).toBe(NOW + HOUR + RESET_MARGIN_MS)
  })

  test('a retry_after key', () => {
    const info = detectLimit('rate_limit_error {"retry_after": 42}', NOW)!
    expect(info.resumeAt).toBe(NOW + 42 * 1000 + RESET_MARGIN_MS)
  })

  test('minutes in prose', () => {
    const info = detectLimit('Usage limit reached. Try again in 25 minutes.', NOW)!
    expect(info.parsed).toBe(true)
    expect(info.resumeAt).toBe(NOW + 25 * MINUTE + RESET_MARGIN_MS)
  })

  test('compound durations are summed, not first-match', () => {
    // "2h 30m" is 150 minutes — taking whichever unit matched first would
    // resume 30 minutes in, straight back into the limit.
    const info = detectLimit('Quota exceeded, resets in 2h 30m', NOW)!
    expect(info.resumeAt).toBe(NOW + 2 * HOUR + 30 * MINUTE + RESET_MARGIN_MS)
  })

  test('hours and days', () => {
    expect(detectLimit('rate limit; try again in 1 hour', NOW)!.resumeAt).toBe(
      NOW + HOUR + RESET_MARGIN_MS,
    )
    expect(detectLimit('plan limit reached, resets in 1 day', NOW)!.resumeAt).toBe(
      NOW + 24 * HOUR + RESET_MARGIN_MS,
    )
  })
})

describe('detectLimit — reset time from a timestamp', () => {
  test('a unix timestamp in seconds', () => {
    const reset = Math.floor((NOW + 2 * HOUR) / 1000)
    const info = detectLimit(`usage limit reached; resets at ${reset}`, NOW)!
    expect(info.parsed).toBe(true)
    expect(info.resumeAt).toBe(reset * 1000 + RESET_MARGIN_MS)
  })

  test('a unix timestamp in milliseconds is not read as seconds', () => {
    // A 13-digit number contains a valid 10-digit prefix; reading that prefix
    // as seconds would land in 1970 and fire instantly.
    const reset = NOW + 2 * HOUR
    const info = detectLimit(`rate limit, x-ratelimit-reset: ${reset}`, NOW)!
    expect(info.resumeAt).toBe(reset + RESET_MARGIN_MS)
  })

  test('an ISO timestamp', () => {
    const reset = new Date(NOW + 3 * HOUR)
    const info = detectLimit(`quota exceeded until ${reset.toISOString()}`, NOW)!
    expect(info.parsed).toBe(true)
    // Rounded to the second by the ISO format
    expect(Math.abs(info.resumeAt - (reset.getTime() + RESET_MARGIN_MS))).toBeLessThan(1000)
  })

  test('a timestamp in the past is rejected, not scheduled', () => {
    // Scheduling a run in the past fires it immediately and straight back into
    // the same limit — so a past timestamp means we misread it.
    const past = Math.floor((NOW - 5 * HOUR) / 1000)
    const info = detectLimit(`rate limit; reset ${past}`, NOW)!
    expect(info.parsed).toBe(false)
    expect(info.resumeAt).toBe(NOW + DEFAULT_WAIT_MS + RESET_MARGIN_MS)
  })

  test('a timestamp beyond the trust window falls back to the default', () => {
    // "resets 2027-01-01" would park the conversation for a year.
    const info = detectLimit('rate limit reached, resets at 2027-01-01T00:00:00Z', NOW)!
    expect(info.parsed).toBe(false)
    expect(info.resumeAt).toBe(NOW + DEFAULT_WAIT_MS + RESET_MARGIN_MS)
    expect(info.resumeAt - NOW).toBeLessThanOrEqual(MAX_WAIT_MS + RESET_MARGIN_MS)
  })
})

describe('detectLimit — reset time from a wall clock', () => {
  test('a later time today', () => {
    // NOW is 12:00; "resets at 15:30" is three and a half hours away.
    const info = detectLimit('Your limit resets at 15:30', NOW)!
    expect(info.parsed).toBe(true)
    expect(info.resumeAt).toBe(new Date(2026, 7, 1, 15, 30).getTime() + RESET_MARGIN_MS)
  })

  test('am/pm is understood', () => {
    const info = detectLimit('usage limit reached, resets at 3pm', NOW)!
    expect(info.resumeAt).toBe(new Date(2026, 7, 1, 15, 0).getTime() + RESET_MARGIN_MS)
  })

  test('a time that has already passed today means tomorrow', () => {
    // "resets at 9am" said at noon cannot mean three hours ago.
    const info = detectLimit('usage limit reached, resets at 9am', NOW)!
    expect(info.resumeAt).toBe(new Date(2026, 7, 2, 9, 0).getTime() + RESET_MARGIN_MS)
  })

  test('a bare number after "resets at" is NOT read as a clock time', () => {
    // "resets at 3" could be a count, a version, anything. Requiring a colon
    // or am/pm keeps a meaningless number from setting the schedule.
    const info = detectLimit('rate limit; resets at 3', NOW)!
    expect(info.parsed).toBe(false)
  })

  test('an impossible clock time falls back rather than throwing', () => {
    const info = detectLimit('rate limit; resets at 99:99', NOW)!
    expect(info.parsed).toBe(false)
  })
})

describe('detectLimit — when no reset time can be read', () => {
  test('a recognised limit with no time still schedules, conservatively', () => {
    // The whole point: the conversation continues by itself even when the
    // provider says nothing about when.
    const info = detectLimit('Rate limit reached for this model', NOW)!
    expect(info.parsed).toBe(false)
    expect(info.resumeAt).toBe(NOW + DEFAULT_WAIT_MS + RESET_MARGIN_MS)
  })

  test('the default wait is an hour — the shortest plan window', () => {
    // Guessing shorter burns the retry against a limit that has not lifted,
    // and some providers count the rejection against the quota.
    expect(DEFAULT_WAIT_MS).toBe(HOUR)
  })

  test('every result carries the five-minute margin the user asked for', () => {
    expect(RESET_MARGIN_MS).toBe(5 * MINUTE)
    const exact = detectLimit('retry after 60 seconds; rate limit', NOW)!
    expect(exact.resumeAt).toBe(NOW + 60 * 1000 + RESET_MARGIN_MS)
  })
})

describe('detectLimit — the resume time is always usable', () => {
  test('it is always in the future, whatever the message says', () => {
    const messages = [
      'rate limit',
      'quota exceeded, retry after 0 seconds',
      'usage limit reached; reset 1000000000',
      '429 resets at 2020-01-01T00:00:00Z',
      'plan limit; try again in 0 minutes',
    ]
    for (const message of messages) {
      const info = detectLimit(message, NOW)
      expect(info).not.toBeNull()
      expect(info!.resumeAt).toBeGreaterThan(NOW)
    }
  })

  test('it never exceeds the trust window plus the margin', () => {
    const messages = [
      'rate limit, resets in 999 days',
      'quota exceeded until 2099-01-01T00:00:00Z',
      'usage limit; retry after 99999999 seconds',
    ]
    for (const message of messages) {
      const info = detectLimit(message, NOW)!
      expect(info.resumeAt - NOW).toBeLessThanOrEqual(MAX_WAIT_MS + RESET_MARGIN_MS)
    }
  })
})

// ===========================================================================
// The user-facing message
// ===========================================================================

describe('limitNotice', () => {
  test('a read reset time is stated as fact', () => {
    const info = detectLimit('rate limit, try again in 30 minutes', NOW)!
    expect(limitNotice(info, 'en-GB')).toContain('continues by itself')
  })

  test('a guessed reset time says so', () => {
    // "resuming at 15:40" reads as something the provider told us. It did not.
    const info = detectLimit('rate limit reached', NOW)!
    const notice = limitNotice(info, 'en-GB')
    expect(notice).toContain('not stated')
    expect(notice).toContain('try again')
  })

  test('both forms name a time', () => {
    for (const message of ['rate limit, try again in 30 minutes', 'rate limit reached']) {
      expect(limitNotice(detectLimit(message, NOW)!, 'en-GB')).toMatch(/\d{2}:\d{2}/)
    }
  })
})
