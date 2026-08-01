// The cron parser and `nextRun`.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY THIS FILE IS LONG. A scheduling bug does not announce itself:    │
// │ the report simply does not arrive, or arrives at 3am, and by the     │
// │ time anyone notices the cause is a week of firings ago. There is no  │
// │ stack trace to work back from — so the arithmetic is pinned down     │
// │ here instead.                                                        │
// └──────────────────────────────────────────────────────────────────────┘
//
// Every test builds its dates with `new Date(y, m, d, ...)` — LOCAL time, the
// same basis `nextRun` works in. Using `Date.UTC` here would make the
// expectations wrong on any machine that is not on UTC.

import { describe, expect, test } from 'bun:test'
import { describeCron, nextRun, nextRunOf, parseCron } from '../src/schedule/cron.ts'

/** A local-time date, written the way the tests read best */
function at(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0)
}

/** `nextRunOf` as a Date, for comparing against `at(...)` */
function next(expression: string, from: Date): Date {
  const ms = nextRunOf(expression, from)
  if (ms === null) throw new Error(`no run found for "${expression}"`)
  return new Date(ms)
}

// ===========================================================================
// Parsing
// ===========================================================================

describe('parseCron — the field syntax', () => {
  test('`*` in every field expands to the full range', () => {
    const spec = parseCron('* * * * *')
    expect(spec.minutes).toHaveLength(60)
    expect(spec.hours).toHaveLength(24)
    expect(spec.daysOfMonth).toHaveLength(31)
    expect(spec.months).toHaveLength(12)
    // 0-7 parses to eight values, but 7 folds onto 0 — seven distinct days
    expect(spec.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(spec.domRestricted).toBe(false)
    expect(spec.dowRestricted).toBe(false)
  })

  test('single values', () => {
    const spec = parseCron('30 9 15 6 3')
    expect(spec.minutes).toEqual([30])
    expect(spec.hours).toEqual([9])
    expect(spec.daysOfMonth).toEqual([15])
    expect(spec.months).toEqual([6])
    expect(spec.daysOfWeek).toEqual([3])
  })

  test('lists', () => {
    expect(parseCron('0,15,30,45 * * * *').minutes).toEqual([0, 15, 30, 45])
  })

  test('ranges', () => {
    expect(parseCron('* 9-17 * * *').hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
  })

  test('steps over the whole range', () => {
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45])
  })

  test('steps within a range', () => {
    expect(parseCron('10-30/5 * * * *').minutes).toEqual([10, 15, 20, 25, 30])
  })

  test('a step from a single value runs to the end of the range', () => {
    // `5/15` = "from 5, every 15" — 5, 20, 35, 50
    expect(parseCron('5/15 * * * *').minutes).toEqual([5, 20, 35, 50])
  })

  test('lists combine with ranges and steps', () => {
    expect(parseCron('0,5-10,20-30/5 * * * *').minutes).toEqual([0, 5, 6, 7, 8, 9, 10, 20, 25, 30])
  })

  test('duplicates collapse and the result is sorted', () => {
    expect(parseCron('30,0,30,15 * * * *').minutes).toEqual([0, 15, 30])
  })

  test('month names are accepted, case-insensitively', () => {
    expect(parseCron('0 0 1 jan *').months).toEqual([1])
    expect(parseCron('0 0 1 DEC *').months).toEqual([12])
    expect(parseCron('0 0 1 mar-may *').months).toEqual([3, 4, 5])
  })

  test('weekday names are accepted', () => {
    expect(parseCron('0 0 * * sun').daysOfWeek).toEqual([0])
    expect(parseCron('0 0 * * mon-fri').daysOfWeek).toEqual([1, 2, 3, 4, 5])
  })

  test('weekday 7 folds onto 0 (both are Sunday)', () => {
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0])
    // 0 and 7 together must not produce two Sundays
    expect(parseCron('0 0 * * 0,7').daysOfWeek).toEqual([0])
  })

  test('surrounding whitespace does not matter', () => {
    expect(parseCron('  0   9  *  *  *  ').hours).toEqual([9])
  })
})

describe('parseCron — what it refuses', () => {
  test('the wrong number of fields', () => {
    expect(() => parseCron('0 9 * *')).toThrow(/5 fields/)
    expect(() => parseCron('0 9 * * * *')).toThrow(/5 fields/)
  })

  test('an empty expression', () => {
    expect(() => parseCron('   ')).toThrow(/empty/)
  })

  test('shorthands are rejected with a usable message', () => {
    // Rejected rather than supported: a user who writes `@daily` and gets
    // silence would have no way to tell whether it was accepted.
    expect(() => parseCron('@daily')).toThrow(/not supported/)
    expect(() => parseCron('@daily')).toThrow(/0 9 \* \* \*/)
  })

  test('values outside the field range', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/out of range/)
    expect(() => parseCron('* 24 * * *')).toThrow(/out of range/)
    expect(() => parseCron('* * 32 * *')).toThrow(/out of range/)
    expect(() => parseCron('* * * 13 *')).toThrow(/out of range/)
    expect(() => parseCron('* * * * 8')).toThrow(/out of range/)
    expect(() => parseCron('* * 0 * *')).toThrow(/out of range/)
  })

  test('nonsense values', () => {
    expect(() => parseCron('abc * * * *')).toThrow(/not a valid value/)
    expect(() => parseCron('* * * xyz *')).toThrow(/not a valid value/)
    expect(() => parseCron('1.5 * * * *')).toThrow(/not a valid value/)
  })

  test('a backwards range is rejected, not silently wrapped', () => {
    expect(() => parseCron('* * * * 5-1')).toThrow(/backwards/)
    expect(() => parseCron('* * * * 5-1')).toThrow(/5-6,0-1/)
  })

  test('a bad step', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(/positive whole number/)
    expect(() => parseCron('*/-5 * * * *')).toThrow(/positive whole number/)
    expect(() => parseCron('*/abc * * * *')).toThrow(/positive whole number/)
  })

  test('malformed punctuation', () => {
    expect(() => parseCron('1/2/3 * * * *')).toThrow(/Too many "\/"/)
    expect(() => parseCron('1-2-3 * * * *')).toThrow(/Too many "-"/)
    expect(() => parseCron('1,,2 * * * *')).toThrow(/Empty value/)
  })

  test('an impossible date is caught at parse time, not by a 5-year search', () => {
    // The point is the ERROR: without the check `nextRun` would walk five
    // years of calendar and report "no run", which reads as a platform fault.
    expect(() => parseCron('0 0 31 2 *')).toThrow(/never occurs/)
    expect(() => parseCron('0 0 31 4 *')).toThrow(/never occurs/)
  })

  test('February 29 IS possible — it just waits for a leap year', () => {
    expect(() => parseCron('0 0 29 2 *')).not.toThrow()
    expect(next('0 0 29 2 *', at(2026, 3, 1))).toEqual(at(2028, 2, 29))
  })

  test('an impossible day-of-month is allowed when a weekday is also given', () => {
    // Cron ORs the two day fields, so the weekday alone can still match.
    expect(() => parseCron('0 0 31 2 mon')).not.toThrow()
  })
})

// ===========================================================================
// nextRun
// ===========================================================================

describe('nextRun — the basics', () => {
  test('the next firing is STRICTLY after the given moment', () => {
    // This is what stops a schedule firing twice: the run stores
    // `nextRun(cron, now)`, and `now` is at or past the firing that just
    // happened. Selecting the same minute again would loop forever.
    const exactly9 = at(2026, 8, 1, 9, 0)
    expect(next('0 9 * * *', exactly9)).toEqual(at(2026, 8, 2, 9, 0))
  })

  test('every day at 09:00 — before the time, same day', () => {
    expect(next('0 9 * * *', at(2026, 8, 1, 7, 30))).toEqual(at(2026, 8, 1, 9, 0))
  })

  test('every day at 09:00 — after the time, next day', () => {
    expect(next('0 9 * * *', at(2026, 8, 1, 9, 30))).toEqual(at(2026, 8, 2, 9, 0))
  })

  test('seconds and milliseconds are discarded, not carried forward', () => {
    // Otherwise `run_at` drifts a little later on every single firing.
    const messy = new Date(2026, 7, 1, 8, 59, 45, 123)
    expect(next('0 9 * * *', messy)).toEqual(at(2026, 8, 1, 9, 0))
  })

  test('every minute', () => {
    expect(next('* * * * *', at(2026, 8, 1, 9, 30))).toEqual(at(2026, 8, 1, 9, 31))
  })

  test('every 15 minutes', () => {
    expect(next('*/15 * * * *', at(2026, 8, 1, 9, 5))).toEqual(at(2026, 8, 1, 9, 15))
    expect(next('*/15 * * * *', at(2026, 8, 1, 9, 50))).toEqual(at(2026, 8, 1, 10, 0))
  })

  test('rolling over an hour, a day, a month and a year', () => {
    expect(next('0 * * * *', at(2026, 8, 1, 9, 30))).toEqual(at(2026, 8, 1, 10, 0))
    expect(next('0 9 * * *', at(2026, 8, 31, 10, 0))).toEqual(at(2026, 9, 1, 9, 0))
    expect(next('0 9 * * *', at(2026, 12, 31, 10, 0))).toEqual(at(2027, 1, 1, 9, 0))
  })
})

describe('nextRun — weekdays', () => {
  test('every Monday at 09:00', () => {
    // 2026-08-01 is a Saturday
    expect(at(2026, 8, 1).getDay()).toBe(6)
    expect(next('0 9 * * mon', at(2026, 8, 1, 12, 0))).toEqual(at(2026, 8, 3, 9, 0))
  })

  test('weekdays only, from a Friday afternoon, lands on Monday', () => {
    const friday = at(2026, 8, 7, 18, 0)
    expect(friday.getDay()).toBe(5)
    expect(next('0 9 * * mon-fri', friday)).toEqual(at(2026, 8, 10, 9, 0))
  })

  test('Sunday is reachable as both 0 and 7', () => {
    const from = at(2026, 8, 3, 12, 0) // Monday
    expect(next('0 9 * * 0', from)).toEqual(at(2026, 8, 9, 9, 0))
    expect(next('0 9 * * 7', from)).toEqual(at(2026, 8, 9, 9, 0))
  })
})

describe('nextRun — the day-of-month / day-of-week OR rule', () => {
  // The one genuinely surprising rule in cron, and not ours to "fix": a user
  // copying an expression from elsewhere expects the standard behaviour.

  test('when BOTH day fields are restricted they are OR-ed', () => {
    // "the 15th, AND ALSO every Monday"
    const from = at(2026, 8, 1, 0, 0) // Saturday
    // The first Monday (the 3rd) comes before the 15th
    expect(next('0 9 15 * mon', from)).toEqual(at(2026, 8, 3, 9, 0))
    // …and the 15th fires too, even though it is a Saturday
    expect(at(2026, 8, 15).getDay()).toBe(6)
    expect(next('0 9 15 * mon', at(2026, 8, 14, 12, 0))).toEqual(at(2026, 8, 15, 9, 0))
  })

  test('day-of-month alone is AND-ed with the month as usual', () => {
    expect(next('0 9 15 * *', at(2026, 8, 1, 0, 0))).toEqual(at(2026, 8, 15, 9, 0))
  })

  test('"Friday the 13th" is NOT what `0 9 13 * fri` means', () => {
    // It means "the 13th, or any Friday" — the very trap the OR rule sets.
    // 2026-08-07 is a Friday and comes first.
    expect(next('0 9 13 * fri', at(2026, 8, 1, 0, 0))).toEqual(at(2026, 8, 7, 9, 0))
  })
})

describe('nextRun — months and sparse expressions', () => {
  test('a specific month', () => {
    expect(next('0 0 1 1 *', at(2026, 8, 1, 0, 0))).toEqual(at(2027, 1, 1, 0, 0))
  })

  test('a quarterly expression', () => {
    expect(next('0 9 1 1,4,7,10 *', at(2026, 8, 1, 0, 0))).toEqual(at(2026, 10, 1, 9, 0))
  })

  test('a once-a-year expression does not walk minute by minute', () => {
    // A naive implementation would iterate ~500k times here. If this test ever
    // starts taking seconds, the field-by-field descent has been broken.
    const started = performance.now()
    expect(next('0 0 1 1 *', at(2026, 1, 2, 0, 0))).toEqual(at(2027, 1, 1, 0, 0))
    expect(performance.now() - started).toBeLessThan(50)
  })

  test('a leap-year-only expression is found across four years', () => {
    expect(next('0 0 29 2 *', at(2026, 1, 1))).toEqual(at(2028, 2, 29))
  })

  test('null when nothing matches inside the search window', () => {
    // Feb 29 falling on a Monday: legitimate, but rarer than the 5-year window.
    // Returning null lets the caller say so instead of storing a run decades out.
    const spec = parseCron('0 0 29 2 *')
    const monday29 = { ...spec, daysOfWeek: [1], dowRestricted: true, domRestricted: true }
    // With the OR rule this would match every Monday, so test the window
    // directly with a day-of-month-only spec far outside five years.
    expect(nextRun({ ...spec, months: [2], daysOfMonth: [30] }, at(2026, 1, 1))).toBeNull()
    expect(monday29.daysOfWeek).toEqual([1]) // guards the fixture above
  })
})

describe('nextRun — repeated application never stalls or repeats', () => {
  test('a daily schedule advances exactly one day at a time', () => {
    let cursor = at(2026, 8, 1, 0, 0)
    const seen: number[] = []
    for (let i = 0; i < 10; i++) {
      const ms = nextRunOf('0 9 * * *', cursor)!
      seen.push(ms)
      cursor = new Date(ms)
    }
    // Strictly increasing, no duplicates — the property that matters
    expect(new Set(seen).size).toBe(10)
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!)
    expect(new Date(seen[0]!)).toEqual(at(2026, 8, 1, 9, 0))
    expect(new Date(seen[9]!)).toEqual(at(2026, 8, 10, 9, 0))
  })

  test('an every-minute schedule never returns the same minute twice', () => {
    let cursor = at(2026, 8, 1, 23, 55)
    const seen = new Set<number>()
    for (let i = 0; i < 20; i++) {
      const ms = nextRunOf('* * * * *', cursor)!
      expect(seen.has(ms)).toBe(false)
      seen.add(ms)
      cursor = new Date(ms)
    }
  })
})

// ===========================================================================
// describeCron
// ===========================================================================

describe('describeCron', () => {
  test('the everyday shapes read as plain language', () => {
    expect(describeCron('0 9 * * *')).toBe('every day at 09:00')
    expect(describeCron('30 14 * * *')).toBe('every day at 14:30')
    expect(describeCron('0 * * * *')).toBe('every hour at :00')
    expect(describeCron('15 * * * *')).toBe('every hour at :15')
    expect(describeCron('*/15 * * * *')).toBe('every 15 minutes')
    expect(describeCron('0 9 * * mon')).toBe('every Monday at 09:00')
    expect(describeCron('0 9 * * mon,fri')).toBe('every Monday, Friday at 09:00')
    expect(describeCron('0 9 1 * *')).toBe('on day 1 of each month at 09:00')
  })

  test('anything unrecognised falls back to the expression itself', () => {
    // A half-right description is worse than none: "every 15 minutes" for an
    // expression that also restricts the month would actively mislead.
    expect(describeCron('*/15 9-17 * 3 mon')).toBe('*/15 9-17 * 3 mon')
    expect(describeCron('0 9,17 * * *')).toBe('0 9,17 * * *')
  })

  test('an invalid expression is returned unchanged rather than throwing', () => {
    // It is used for display, including in error paths — throwing here would
    // turn a bad-input message into a crash.
    expect(describeCron('nonsense')).toBe('nonsense')
    expect(describeCron('@daily')).toBe('@daily')
  })
})
