// A 5-field cron parser and "when does this next fire?".
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY WE WRITE THIS RATHER THAN INSTALLING IT.                         │
// │                                                                      │
// │ The cron packages on npm are not large, but they all bring a         │
// │ timezone database and a scheduler of their own — and we need neither │
// │ (the platform runs in the machine's local time, and the tick lives   │
// │ in `scheduler.ts`). What is left of such a package after removing    │
// │ those two things is exactly the file you are reading.                │
// │                                                                      │
// │ The deal that makes this safe: NO SEARCHING FORWARD MINUTE BY        │
// │ MINUTE. `nextRun` walks the calendar field by field, so an           │
// │ expression that fires once a year costs the same as one that fires   │
// │ every minute. A naive implementation ("add a minute, test, repeat")  │
// │ would spin 525,600 times for `0 0 1 1 *` and look like a hang.       │
// └──────────────────────────────────────────────────────────────────────┘
//
// THE SUPPORTED SYNTAX — the common subset, deliberately:
//
//     ┌─────── minute        0-59
//     │ ┌───── hour          0-23
//     │ │ ┌─── day of month  1-31
//     │ │ │ ┌─ month         1-12  (or jan-dec)
//     │ │ │ │ ┌ day of week  0-6   (0 = Sunday, or sun-sat; 7 also = Sunday)
//     * * * * *
//
//   `*`      every value          `5`       one value
//   `1,3,5`  a list               `1-5`     a range
//   `*/15`   a step               `10-30/5` a step within a range
//
// NOT supported, and rejected rather than misread: `@daily` and friends, `L`,
// `W`, `#`, `?`. A silently misparsed schedule fires at the wrong time and the
// user has no way to tell — an error at creation time is the kinder failure.
//
// LOCAL TIME, AND WHAT THAT COSTS. "Every day at 09:00" means nine in the
// morning where the user is, so the fields are matched against local time.
// The consequence is the daylight-saving seam: on the day the clock jumps
// forward, an expression naming a skipped hour does not fire (there is no
// 02:30 that day), and on the day it goes back, `nextRun` returns the FIRST of
// the two possible instants — it never fires twice, because `run_at` only ever
// moves forward. Uzbekistan has no DST, so this affects nobody today; it is
// written down because the behaviour is a choice, not an accident.

/** How far ahead `nextRun` is willing to look before giving up */
const SEARCH_LIMIT_YEARS = 5

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface FieldSpec {
  min: number
  max: number
  /** Names accepted in place of numbers (`jan`, `mon`, …) */
  names?: string[]
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12, names: MONTH_NAMES },
  { min: 0, max: 7, names: DAY_NAMES }, // 7 is folded to 0 below
]

/**
 * A parsed expression: the allowed values of each field, as sorted arrays.
 *
 * `dayOfWeek`/`dayOfMonth` keep a `restricted` flag because of the cron rule
 * in `matchesDay` — the distinction is lost once they are plain lists.
 */
export interface CronSpec {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
  /** Whether day-of-month was something other than `*` */
  domRestricted: boolean
  /** Whether day-of-week was something other than `*` */
  dowRestricted: boolean
}

/**
 * Parses a cron expression. Throws with a message meant for the USER — it
 * reaches them through the REST error and the agent's tool result.
 */
export function parseCron(expression: string): CronSpec {
  const trimmed = expression.trim()
  if (!trimmed) throw new Error('The cron expression is empty')

  if (trimmed.startsWith('@')) {
    throw new Error(
      `Shorthands such as "${trimmed}" are not supported. Write the five fields out: ` +
        '"0 9 * * *" is every day at 09:00.',
    )
  }

  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(
      `A cron expression has 5 fields (minute hour day month weekday), got ${parts.length}: "${trimmed}"`,
    )
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string]

  const spec: CronSpec = {
    minutes: parseField(minute, FIELDS[0]!, 'minute'),
    hours: parseField(hour, FIELDS[1]!, 'hour'),
    daysOfMonth: parseField(dayOfMonth, FIELDS[2]!, 'day of month'),
    months: parseField(month, FIELDS[3]!, 'month'),
    // 7 and 0 both mean Sunday — fold them together so `matchesDay` can compare
    // against `getDay()` directly.
    daysOfWeek: unique(parseField(dayOfWeek, FIELDS[4]!, 'weekday').map((d) => (d === 7 ? 0 : d))),
    domRestricted: dayOfMonth !== '*',
    dowRestricted: dayOfWeek !== '*',
  }

  // A date that can never occur — "31 February". Without this check `nextRun`
  // would search for five years and then report "no run found", which reads as
  // a platform fault rather than a typo.
  if (!hasPossibleDate(spec)) {
    throw new Error(
      `This date never occurs: day ${dayOfMonth} in month ${month}. Check the expression.`,
    )
  }

  return spec
}

/** One field: a star, `5`, `1,3`, `1-5`, a step, or a step within a range */
function parseField(raw: string, field: FieldSpec, label: string): number[] {
  const values: number[] = []

  for (const part of raw.split(',')) {
    if (!part) throw new Error(`Empty value in the ${label} field: "${raw}"`)

    // A step: the part before `/` is the range it steps through
    const [rangePart, stepPart, ...extra] = part.split('/')
    if (extra.length > 0) throw new Error(`Too many "/" in the ${label} field: "${part}"`)

    let step = 1
    if (stepPart !== undefined) {
      step = Number(stepPart)
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`The step must be a positive whole number in the ${label} field: "${part}"`)
      }
    }

    const [from, to] = parseRange(rangePart ?? '', field, label, stepPart !== undefined)
    for (let v = from; v <= to; v += step) values.push(v)
  }

  if (values.length === 0) throw new Error(`The ${label} field matches nothing: "${raw}"`)
  return unique(values)
}

/**
 * The range part of a field — returns `[from, to]`.
 *
 * `hadStep` matters for the bare `*`: a star alone means the whole range, and
 * so does a star before a step (the whole range, stepped). They are the same
 * thing here, but the flag documents that `5/15` (a step from a single value)
 * is also legal and means "from 5 to the maximum".
 */
function parseRange(
  raw: string,
  field: FieldSpec,
  label: string,
  hadStep: boolean,
): [number, number] {
  if (raw === '*') return [field.min, field.max]

  const [fromRaw, toRaw, ...extra] = raw.split('-')
  if (extra.length > 0) throw new Error(`Too many "-" in the ${label} field: "${raw}"`)

  const from = parseValue(fromRaw ?? '', field, label)

  if (toRaw === undefined) {
    // `5/15` — a single value followed by a step runs to the end of the range;
    // `5` on its own is just itself.
    return hadStep ? [from, field.max] : [from, from]
  }

  const to = parseValue(toRaw, field, label)
  if (to < from) {
    // Wrapping ranges (`fri-mon`) are accepted by some cron implementations and
    // rejected by others. Rejecting is the safe half of that disagreement: the
    // user writes `fri-sat,sun-mon` and there is nothing left to guess.
    throw new Error(
      `The range runs backwards in the ${label} field: "${raw}". Write it as two parts, e.g. "5-6,0-1".`,
    )
  }
  return [from, to]
}

/** One number or name (`9`, `jan`, `mon`) */
function parseValue(raw: string, field: FieldSpec, label: string): number {
  const text = raw.trim().toLowerCase()
  if (!text) throw new Error(`Missing value in the ${label} field`)

  if (field.names) {
    const index = field.names.indexOf(text)
    // Months are 1-based, weekdays 0-based — which is exactly `field.min`.
    if (index >= 0) return index + field.min
  }

  const value = Number(text)
  if (!Number.isInteger(value)) {
    throw new Error(`"${raw}" is not a valid value in the ${label} field`)
  }
  if (value < field.min || value > field.max) {
    throw new Error(
      `${value} is out of range in the ${label} field (${field.min}-${field.max})`,
    )
  }
  return value
}

/**
 * Whether any calendar date can satisfy the day/month fields.
 *
 * Only the impossible COMBINATION is caught here (31 September, 30 February).
 * February 29 IS possible — it just waits for a leap year, and the five-year
 * search window in `nextRun` covers that.
 */
function hasPossibleDate(spec: CronSpec): boolean {
  // When day-of-week is unrestricted the day-of-month list must fit some month;
  // when it IS restricted, cron's OR rule (see `matchesDay`) means a weekday
  // match alone is enough and any date is reachable.
  if (!spec.domRestricted || spec.dowRestricted) return true

  const longest: Record<number, number> = {
    1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30,
    7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31,
  }
  return spec.months.some((m) => spec.daysOfMonth.some((d) => d <= (longest[m] ?? 31)))
}

/**
 * The first firing STRICTLY AFTER `from`. Returns epoch ms.
 *
 * "Strictly after" is what stops a schedule firing twice: the run records
 * `nextRun(cron, now)`, and since `now` is at or past the firing that just
 * happened, the same minute can never be selected again.
 *
 * Returns `null` when nothing matches within five years — only reachable for
 * expressions like "February 29 on a Monday", which is legitimate but rare
 * enough that the caller should report it rather than store a run 30 years out.
 */
export function nextRun(spec: CronSpec, from: Date = new Date()): number | null {
  // Start from the next whole minute: seconds and milliseconds are not part of
  // cron, and keeping them would make `run_at` drift a little later on every
  // firing.
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  const deadline = new Date(cursor.getTime())
  deadline.setFullYear(deadline.getFullYear() + SEARCH_LIMIT_YEARS)

  // Field-by-field descent. Each step either matches or advances the cursor to
  // the next candidate for THAT field and zeroes everything smaller — which is
  // what keeps this bounded no matter how sparse the expression is.
  while (cursor.getTime() <= deadline.getTime()) {
    if (!spec.months.includes(cursor.getMonth() + 1)) {
      // Move to the 1st of next month, midnight
      cursor.setMonth(cursor.getMonth() + 1, 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }

    if (!matchesDay(spec, cursor)) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }

    if (!spec.hours.includes(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      continue
    }

    if (!spec.minutes.includes(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
      continue
    }

    return cursor.getTime()
  }

  return null
}

/**
 * The day match — and the one genuinely surprising rule in cron.
 *
 * When BOTH day-of-month and day-of-week are restricted they are OR'd, not
 * AND'd: `0 0 1 * mon` means "the 1st of the month, AND ALSO every Monday".
 * Every other pair of fields is AND'd. This is not a quirk we are free to fix
 * — `0 0 13 * fri` is how "Friday the 13th" is NOT written, and a user copying
 * an expression from elsewhere expects the standard behaviour.
 */
function matchesDay(spec: CronSpec, date: Date): boolean {
  const dom = spec.daysOfMonth.includes(date.getDate())
  const dow = spec.daysOfWeek.includes(date.getDay())

  if (spec.domRestricted && spec.dowRestricted) return dom || dow
  if (spec.domRestricted) return dom
  if (spec.dowRestricted) return dow
  return true
}

/**
 * Parse and compute in one step — the form the callers actually want.
 *
 * Throws on a bad expression (the message is for the user); returns `null`
 * when the expression is valid but has no firing within the search window.
 */
export function nextRunOf(expression: string, from: Date = new Date()): number | null {
  return nextRun(parseCron(expression), from)
}

/**
 * A plain-language rendering for the UI list and the agent's tool result.
 *
 * It covers the SHAPES PEOPLE ACTUALLY WRITE and falls back to the raw
 * expression otherwise. A half-right description ("every 15 minutes" for
 * something that also has a month restriction) would be worse than showing the
 * expression itself, so the fallback triggers on anything unrecognised.
 */
export function describeCron(expression: string): string {
  let spec: CronSpec
  try {
    spec = parseCron(expression)
  } catch {
    return expression
  }

  const everyMonth = spec.months.length === 12
  const everyDom = !spec.domRestricted
  const everyDow = !spec.dowRestricted

  const time = (h: number, m: number) => `${pad(h)}:${pad(m)}`
  const single = spec.hours.length === 1 && spec.minutes.length === 1

  if (everyMonth && everyDom && everyDow) {
    if (single) return `every day at ${time(spec.hours[0]!, spec.minutes[0]!)}`
    if (spec.hours.length === 24 && spec.minutes.length === 1) {
      return `every hour at :${pad(spec.minutes[0]!)}`
    }
    if (isEvenStep(spec.minutes, 60) && spec.hours.length === 24) {
      return `every ${spec.minutes[1]! - spec.minutes[0]!} minutes`
    }
  }

  if (everyMonth && everyDom && !everyDow && single) {
    const days = spec.daysOfWeek.map((d) => WEEKDAY_LABELS[d] ?? String(d)).join(', ')
    return `every ${days} at ${time(spec.hours[0]!, spec.minutes[0]!)}`
  }

  if (everyMonth && !everyDom && everyDow && single && spec.daysOfMonth.length === 1) {
    return `on day ${spec.daysOfMonth[0]} of each month at ${time(spec.hours[0]!, spec.minutes[0]!)}`
  }

  return expression
}

const WEEKDAY_LABELS: Record<number, string> = {
  0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday',
  4: 'Thursday', 5: 'Friday', 6: 'Saturday',
}

/** Whether a list is an even step covering the whole range (0,15,30,45 for 15) */
function isEvenStep(values: number[], range: number): boolean {
  if (values.length < 2) return false
  const step = values[1]! - values[0]!
  if (step < 1 || values.length !== Math.ceil(range / step)) return false
  return values.every((v, i) => v === values[0]! + i * step)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function unique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}
