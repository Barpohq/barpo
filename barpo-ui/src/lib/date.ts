// Date formatting — for the conversation list.
//
// Pure functions: "now" is passed in (the `now` argument), so they are
// testable and do not depend on the passage of time.

/** One day, in milliseconds */
const DAY = 24 * 60 * 60 * 1000

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/**
 * Which group a conversation falls into.
 *
 * By CALENDAR day, not by "within 24 hours": a conversation from 23:00
 * yesterday must still read as "Yesterday" at 01:00 today, not "Today".
 */
export type DateGroup = 'Today' | 'Yesterday' | 'This week' | 'This month' | 'Older'

/** Start of the day (in the local time zone) */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function dateGroup(iso: string, now: Date = new Date()): DateGroup {
  const date = new Date(iso)
  // A malformed date must not break the list — it lands in the bottom group
  if (Number.isNaN(date.getTime())) return 'Older'

  // The difference in DAYs: since both dates are pulled back to the start of
  // the day this is always a whole number (rounding fixes DST transitions).
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY)
  // A date in the future (a wrongly set clock) — treated as "Today"
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'This week'
  if (days < 30) return 'This month'
  return 'Older'
}

/** The groups appear in the list in this order */
export const GROUP_ORDER: DateGroup[] = [
  'Today',
  'Yesterday',
  'This week',
  'This month',
  'Older',
]

/**
 * Short relative time: "now", "5 min", "3 h", "Jul 12".
 *
 * It sits at the right edge of every row in the list — hence as short as
 * possible.
 */
export function shortTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} d`

  // Past a week an explicit date is easier to read: "Jul 12"
  const month = MONTHS[date.getMonth()] ?? ''
  // If it is another year, show the year too
  return date.getFullYear() === now.getFullYear()
    ? `${month} ${date.getDate()}`
    : `${month} ${date.getDate()}, ${date.getFullYear()}`
}

/**
 * The date part of an audit entry — empty for today.
 *
 * The audit log keeps its exact "HH:MM" (you read it to find out WHEN
 * something happened), but once the log spans several days the clock time
 * alone is ambiguous: 09:00 today and 09:00 last week render identically.
 * This adds the day in front, and only when it is not today — otherwise every
 * row on a fresh platform would carry the same redundant date.
 *
 * `iso` is optional: entries written before the field existed do not have it,
 * and those simply keep showing the bare time.
 */
export function auditDate(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY)
  // Today, or a clock set in the future — the time alone is unambiguous
  if (days <= 0) return ''

  const month = MONTHS[date.getMonth()] ?? ''
  return date.getFullYear() === now.getFullYear()
    ? `${month} ${date.getDate()}`
    : `${month} ${date.getDate()}, ${date.getFullYear()}`
}
