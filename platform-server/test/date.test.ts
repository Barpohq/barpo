// Date grouping and short times (platform-ui/src/lib/date.ts).
//
// WHY IT LIVES IN THE SERVER TESTS: the same reason as `hash-path.test.ts` —
// the functions are pure (they never touch the DOM) and the UI package has no
// test harness.
//
// "Now" is passed EXPLICITLY in every test, so the results do not depend on
// when the suite happens to run.

import { describe, expect, test } from 'bun:test'
import { GROUP_ORDER, shortTime, dateGroup, auditDate } from '../../platform-ui/src/lib/date.ts'

/** One "now" shared by every test: 2026-07-28 at 14:00 */
const NOW = new Date(2026, 6, 28, 14, 0, 0)

/** Builds an ISO string in the local time zone — tests must not depend on it */
function date(year: number, month: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString()
}

describe('dateGroup', () => {
  test("a conversation from today is grouped under Today", () => {
    expect(dateGroup(date(2026, 7, 28, 9), NOW)).toBe('Today')
  })

  test('00:30 this morning still counts as Today', () => {
    expect(dateGroup(date(2026, 7, 28, 0, 30), NOW)).toBe('Today')
  })

  test("a conversation from yesterday is grouped under Yesterday", () => {
    expect(dateGroup(date(2026, 7, 27, 20), NOW)).toBe('Yesterday')
  })

  // This is the whole point: grouping goes by CALENDAR day, not by "within the
  // last 24 hours". A conversation at 23:00 last night is Yesterday even
  // though only 15 hours have passed.
  test('23:00 yesterday is Yesterday even though 24 hours have not passed', () => {
    expect(dateGroup(date(2026, 7, 27, 23), NOW)).toBe('Yesterday')
  })

  test('three days ago falls under This week', () => {
    expect(dateGroup(date(2026, 7, 25), NOW)).toBe('This week')
  })

  test('two weeks ago falls under This month', () => {
    expect(dateGroup(date(2026, 7, 14), NOW)).toBe('This month')
  })

  test('two months ago falls under Older', () => {
    expect(dateGroup(date(2026, 5, 20), NOW)).toBe('Older')
  })

  test('a date in the future falls under Today (a wrongly set clock)', () => {
    expect(dateGroup(date(2026, 8, 5), NOW)).toBe('Today')
  })

  test('a malformed date does not break the list', () => {
    expect(dateGroup('not a date', NOW)).toBe('Older')
  })

  test('the returned group is always one of GROUP_ORDER', () => {
    const samples = [
      date(2026, 7, 28),
      date(2026, 7, 27),
      date(2026, 7, 24),
      date(2026, 7, 10),
      date(2025, 1, 1),
    ]
    for (const s of samples) {
      expect(GROUP_ORDER).toContain(dateGroup(s, NOW))
    }
  })
})

describe('shortTime', () => {
  test("less than a minute reads as 'now'", () => {
    expect(shortTime(date(2026, 7, 28, 14, 0), NOW)).toBe('now')
  })

  test("exactly one minute reads as '1 min'", () => {
    expect(shortTime(date(2026, 7, 28, 13, 59), NOW)).toBe('1 min')
  })

  test('minutes', () => {
    expect(shortTime(date(2026, 7, 28, 13, 25), NOW)).toBe('35 min')
  })

  test('hours', () => {
    expect(shortTime(date(2026, 7, 28, 9, 0), NOW)).toBe('5 h')
  })

  test('days', () => {
    expect(shortTime(date(2026, 7, 25, 14), NOW)).toBe('3 d')
  })

  test('past a week it shows the date, without the year if it is this year', () => {
    expect(shortTime(date(2026, 7, 12), NOW)).toBe('Jul 12')
  })

  test('another year is shown with the year', () => {
    expect(shortTime(date(2025, 11, 3), NOW)).toBe('Nov 3, 2025')
  })

  test('a malformed date yields an empty string', () => {
    expect(shortTime('not a date', NOW)).toBe('')
  })
})

describe('auditDate', () => {
  // The audit log keeps its exact "HH:MM"; this only supplies the DAY, and
  // only when the clock time alone would be ambiguous.
  test('today is empty — the time alone is unambiguous', () => {
    expect(auditDate(date(2026, 7, 28, 9, 0), NOW)).toBe('')
  })

  test('an earlier day carries its date', () => {
    // Without this, an entry from 09:00 today and one from 09:00 yesterday
    // render identically — the whole reason the field exists.
    expect(auditDate(date(2026, 7, 27, 9, 0), NOW)).toBe('Jul 27')
  })

  test('another year is shown with the year', () => {
    expect(auditDate(date(2025, 11, 3), NOW)).toBe('Nov 3, 2025')
  })

  test('a date at 23:00 yesterday is still yesterday at 14:00 today', () => {
    // Calendar days, not 24-hour windows — 15 hours apart, but a different day
    expect(auditDate(date(2026, 7, 27, 23, 0), NOW)).toBe('Jul 27')
  })

  test('a future date (a wrongly set clock) is treated as today', () => {
    expect(auditDate(date(2026, 7, 29, 9, 0), NOW)).toBe('')
  })

  test('a missing field yields an empty string', () => {
    // Entries written before `at` existed — they keep showing the bare time
    expect(auditDate(undefined, NOW)).toBe('')
  })

  test('a malformed date yields an empty string', () => {
    expect(auditDate('not a date', NOW)).toBe('')
  })
})
