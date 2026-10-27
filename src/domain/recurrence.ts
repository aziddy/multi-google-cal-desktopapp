import { Temporal } from '@js-temporal/polyfill'

export type Frequency = 'none' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
export interface RecurrenceRule {
  frequency: Frequency
  interval: number
  weekdays: string[]
  ending: 'never' | 'count' | 'until'
  count: number
  until: string
}
export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
export function defaultRecurrence(date: string): RecurrenceRule {
  return {
    frequency: 'none',
    interval: 1,
    weekdays: [WEEKDAYS[Temporal.PlainDate.from(date).dayOfWeek % 7]],
    ending: 'never',
    count: 10,
    until: date,
  }
}
export function parseRecurrence(
  rules: string[] | null | undefined,
  date: string,
  zone: string,
): RecurrenceRule | null {
  const rule = defaultRecurrence(date)
  if (!rules?.length) return rule
  if (rules.length !== 1 || !rules[0].startsWith('RRULE:')) return null
  const pairs = rules[0]
    .slice(6)
    .split(';')
    .map((field) => field.split('='))
  if (
    pairs.some((pair) => pair.length !== 2) ||
    new Set(pairs.map(([key]) => key)).size !== pairs.length
  )
    return null
  const fields: Record<string, string> = Object.fromEntries(pairs)
  if (
    Object.keys(fields).some(
      (key) =>
        !['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTH', 'BYMONTHDAY', 'COUNT', 'UNTIL'].includes(key),
    )
  )
    return null
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(fields.FREQ)) return null
  rule.frequency = fields.FREQ as Frequency
  rule.interval = Number(fields.INTERVAL ?? 1)
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 999) return null
  if (fields.BYDAY) {
    if (
      rule.frequency !== 'WEEKLY' ||
      fields.BYDAY.split(',').some((day) => !WEEKDAYS.includes(day))
    )
      return null
    rule.weekdays = fields.BYDAY.split(',')
  }
  const anchor = Temporal.PlainDate.from(date)
  if (
    fields.BYMONTHDAY &&
    (!['MONTHLY', 'YEARLY'].includes(rule.frequency) || Number(fields.BYMONTHDAY) !== anchor.day)
  )
    return null
  if (fields.BYMONTH && (rule.frequency !== 'YEARLY' || Number(fields.BYMONTH) !== anchor.month))
    return null
  if (fields.COUNT && fields.UNTIL) return null
  if (fields.COUNT) {
    rule.ending = 'count'
    rule.count = Number(fields.COUNT)
    if (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > 9999) return null
  }
  if (fields.UNTIL) {
    rule.ending = 'until'
    try {
      if (/^\d{8}$/.test(fields.UNTIL))
        rule.until = Temporal.PlainDate.from(
          `${fields.UNTIL.slice(0, 4)}-${fields.UNTIL.slice(4, 6)}-${fields.UNTIL.slice(6, 8)}`,
        ).toString()
      else if (/^\d{8}T\d{6}Z$/.test(fields.UNTIL)) {
        const v = fields.UNTIL
        rule.until = Temporal.Instant.from(
          `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`,
        )
          .toZonedDateTimeISO(zone)
          .toPlainDate()
          .toString()
      } else return null
    } catch {
      return null
    }
  }
  return rule
}
export function buildRecurrence(
  rule: RecurrenceRule,
  date: string,
  allDay: boolean,
  zone: string,
): string[] {
  if (rule.frequency === 'none') return []
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 999)
    throw new Error('Choose a repeat interval between 1 and 999.')
  const anchor = Temporal.PlainDate.from(date)
  const fields = [`FREQ=${rule.frequency}`, `INTERVAL=${rule.interval}`]
  if (rule.frequency === 'WEEKLY') {
    const days = WEEKDAYS.filter((day) => rule.weekdays.includes(day))
    if (!days.length) throw new Error('Choose at least one weekday.')
    fields.push(`BYDAY=${days.join(',')}`)
  }
  if (rule.frequency === 'MONTHLY' || rule.frequency === 'YEARLY')
    fields.push(`BYMONTHDAY=${anchor.day}`)
  if (rule.frequency === 'YEARLY') fields.push(`BYMONTH=${anchor.month}`)
  if (rule.ending === 'count') {
    if (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > 9999)
      throw new Error('Choose a count between 1 and 9999.')
    fields.push(`COUNT=${rule.count}`)
  }
  if (rule.ending === 'until') {
    const end = Temporal.PlainDate.from(rule.until)
    if (Temporal.PlainDate.compare(end, anchor) < 0)
      throw new Error('Repeat until must be on or after the start date.')
    const until = allDay
      ? end.toString().replaceAll('-', '')
      : end
          .toPlainDateTime('23:59:59')
          .toZonedDateTime(zone)
          .toInstant()
          .toString({ smallestUnit: 'second' })
          .replaceAll('-', '')
          .replaceAll(':', '')
    fields.push(`UNTIL=${until}`)
  }
  return [`RRULE:${fields.join(';')}`]
}
