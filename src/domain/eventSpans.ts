import { Temporal } from '@js-temporal/polyfill'
import { addDays, eventDateRange } from './calendar'
import type { CalendarEvent } from './types'

export interface EventSpan {
  key: string
  event: CalendarEvent
  /** Zero-based columns, with an exclusive end. */
  start: number
  end: number
  row: number
  spanning: boolean
  continuesBefore: boolean
  continuesAfter: boolean
}

/** Short overnight events and events lasting exactly 24 hours keep their timed layout. */
export function isSpanningEvent(event: CalendarEvent): boolean {
  return (
    event.allDay ||
    Temporal.Instant.compare(
      Temporal.Instant.from(event.end),
      Temporal.Instant.from(event.start).add({ hours: 24 }),
    ) > 0
  )
}

/** Pack a consecutive row of visible dates, optionally including per-day timed entries. */
export function layoutEventSpans(
  days: readonly string[],
  dailyEvents: ReadonlyMap<string, readonly CalendarEvent[]>,
  timeZone: string,
  includeDailyEvents = false,
): EventSpan[] {
  if (!days.length) return []
  const events = new Map<string, CalendarEvent>()
  for (const day of days)
    for (const event of dailyEvents.get(day) ?? [])
      events.set(JSON.stringify([event.accountId, event.calendarId, event.id]), event)

  const spans: EventSpan[] = []
  const rangeEnd = addDays(days[days.length - 1], 1)
  for (const [key, event] of events) {
    const spanning = isSpanningEvent(event)
    if (!spanning && !includeDailyEvents) continue
    const range = eventDateRange(event, timeZone)
    if (!range) continue
    const start = days.findIndex((day) => day >= range.startDate && day < range.endDate)
    if (start < 0) continue
    let end = start + 1
    while (end < days.length && days[end] < range.endDate) end++
    if (spanning) {
      spans.push({
        key,
        event,
        start,
        end,
        row: 0,
        spanning,
        continuesBefore: range.startDate < days[0],
        continuesAfter: range.endDate > rangeEnd,
      })
    } else {
      for (let column = start; column < end; column++)
        spans.push({
          key: `${key}:${column}`,
          event,
          start: column,
          end: column + 1,
          row: 0,
          spanning,
          continuesBefore: false,
          continuesAfter: false,
        })
    }
  }

  const multiDay = (span: EventSpan) =>
    span.end - span.start > 1 || span.continuesBefore || span.continuesAfter
  spans.sort(
    (a, b) =>
      Number(multiDay(b)) - Number(multiDay(a)) ||
      Number(b.spanning) - Number(a.spanning) ||
      a.start - b.start ||
      b.end - a.end ||
      Number(b.event.allDay) - Number(a.event.allDay) ||
      a.event.start.localeCompare(b.event.start) ||
      a.key.localeCompare(b.key),
  )
  const occupied: boolean[][] = []
  for (const span of spans) {
    let row = 0
    while (occupied[row]?.slice(span.start, span.end).some(Boolean)) row++
    occupied[row] ??= []
    for (let column = span.start; column < span.end; column++) occupied[row][column] = true
    span.row = row
  }
  return spans
}

/** Reserve overflow space without ever hiding only part of a spanning bar. */
export function limitEventSpans(spans: EventSpan[], capacity: number, dayCount: number) {
  const hidden = new Set(spans.filter((span) => span.row >= capacity))
  const overflow = Array<boolean>(dayCount).fill(false)
  for (const span of hidden)
    for (let column = span.start; column < span.end; column++) overflow[column] = true
  for (const span of spans)
    if (span.row === capacity - 1 && overflow.slice(span.start, span.end).some(Boolean))
      hidden.add(span)

  const hiddenCounts = Array<number>(dayCount).fill(0)
  for (const span of hidden)
    for (let column = span.start; column < span.end; column++) hiddenCounts[column]++
  return { visible: spans.filter((span) => !hidden.has(span)), hiddenCounts }
}
