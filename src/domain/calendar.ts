import { Temporal } from '@js-temporal/polyfill'
import type { CalendarEvent, EventInput } from './types'

export const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

export interface TimedSegment {
  event: CalendarEvent
  startMinute: number
  endMinute: number
  column: number
  columns: number
}

export function todayDate(timeZone = DEFAULT_TIME_ZONE): string {
  return Temporal.Now.plainDateISO(timeZone).toString()
}

export function addDays(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString()
}

export function addMonths(date: string, months: number): string {
  return Temporal.PlainDate.from(date).add({ months }, { overflow: 'constrain' }).toString()
}

export function startOfWeek(date: string): string {
  const day = Temporal.PlainDate.from(date)
  return day.subtract({ days: day.dayOfWeek % 7 }).toString()
}

export function monthDays(date: string): string[] {
  const first = Temporal.PlainDate.from(date).with({ day: 1 }).toString()
  const start = startOfWeek(first)
  return Array.from({ length: 42 }, (_, index) => addDays(start, index))
}

export function formatDate(
  date: string,
  options: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', year: 'numeric' },
  timeZone = DEFAULT_TIME_ZONE,
): string {
  const instant = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? Temporal.PlainDate.from(date).toZonedDateTime(timeZone).toInstant()
    : Temporal.Instant.from(date)
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(
    instant.epochMilliseconds,
  )
}

/** Dates touched by an event; both date-only and timed end boundaries are exclusive. */
export function eventDates(event: CalendarEvent, timeZone = DEFAULT_TIME_ZONE): string[] {
  let start: Temporal.PlainDate
  let exclusiveEnd: Temporal.PlainDate
  if (event.allDay) {
    start = Temporal.PlainDate.from(event.start)
    exclusiveEnd = Temporal.PlainDate.from(event.end)
  } else {
    const startInstant = Temporal.Instant.from(event.start)
    const endInstant = Temporal.Instant.from(event.end)
    if (Temporal.Instant.compare(endInstant, startInstant) <= 0) return []
    start = startInstant.toZonedDateTimeISO(timeZone).toPlainDate()
    // Subtracting a nanosecond keeps a midnight end out of the following day.
    exclusiveEnd = endInstant
      .subtract({ nanoseconds: 1 })
      .toZonedDateTimeISO(timeZone)
      .toPlainDate()
      .add({ days: 1 })
  }
  const dates: string[] = []
  for (
    let date = start;
    Temporal.PlainDate.compare(date, exclusiveEnd) < 0;
    date = date.add({ days: 1 })
  ) {
    dates.push(date.toString())
  }
  return dates
}

function minuteOfDay(date: Temporal.ZonedDateTime): number {
  return date.hour * 60 + date.minute + date.second / 60
}

/** Pack connected overlap groups into columns using local wall-clock positions. */
export function timedSegments(
  events: CalendarEvent[],
  date: string,
  timeZone = DEFAULT_TIME_ZONE,
): TimedSegment[] {
  const dayStart = Temporal.PlainDate.from(date).toZonedDateTime(timeZone).toInstant()
  const dayEnd = Temporal.PlainDate.from(date)
    .add({ days: 1 })
    .toZonedDateTime(timeZone)
    .toInstant()
  const segments: TimedSegment[] = []

  for (const event of events) {
    if (event.allDay) continue
    const start = Temporal.Instant.from(event.start)
    const end = Temporal.Instant.from(event.end)
    if (
      Temporal.Instant.compare(start, dayEnd) >= 0 ||
      Temporal.Instant.compare(end, dayStart) <= 0
    )
      continue
    const clippedStart = Temporal.Instant.compare(start, dayStart) <= 0 ? dayStart : start
    const clippedEnd = Temporal.Instant.compare(end, dayEnd) >= 0 ? dayEnd : end
    const startMinute =
      Temporal.Instant.compare(clippedStart, dayStart) === 0
        ? 0
        : minuteOfDay(clippedStart.toZonedDateTimeISO(timeZone))
    let endMinute =
      Temporal.Instant.compare(clippedEnd, dayEnd) === 0
        ? 1440
        : minuteOfDay(clippedEnd.toZonedDateTimeISO(timeZone))
    // During a fall-back fold, repeated wall times still need a visible duration.
    if (endMinute <= startMinute) {
      endMinute = Math.min(
        1440,
        startMinute + (clippedEnd.epochMilliseconds - clippedStart.epochMilliseconds) / 60_000,
      )
    }
    if (endMinute > startMinute)
      segments.push({ event, startMinute, endMinute, column: 0, columns: 1 })
  }

  segments.sort(
    (left, right) =>
      left.startMinute - right.startMinute ||
      right.endMinute - left.endMinute ||
      left.event.id.localeCompare(right.event.id),
  )
  let group: TimedSegment[] = []
  let columnEnds: number[] = []
  let groupEnd = -1
  const finish = () => {
    for (const segment of group) segment.columns = columnEnds.length
    group = []
    columnEnds = []
  }
  for (const segment of segments) {
    if (segment.startMinute >= groupEnd) finish()
    let column = columnEnds.findIndex((end) => end <= segment.startMinute)
    if (column < 0) column = columnEnds.length
    segment.column = column
    columnEnds[column] = segment.endMinute
    group.push(segment)
    groupEnd = Math.max(group.length === 1 ? -1 : groupEnd, segment.endMinute)
  }
  finish()
  return segments
}

function asInput(event: CalendarEvent): EventInput {
  return {
    accountId: event.accountId,
    calendarId: event.calendarId,
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    timeZone: event.timeZone,
    ...(event.location !== undefined && { location: event.location }),
    ...(event.description !== undefined && { description: event.description }),
  }
}

function instantAtMinute(date: string, minute: number, timeZone: string): Temporal.Instant {
  if (!Number.isFinite(minute)) throw new Error('Choose a valid event time.')
  // Temporal's compatible disambiguation advances nonexistent spring-forward times
  // and chooses the earlier occurrence of repeated fall-back times.
  return Temporal.PlainDate.from(date)
    .toPlainDateTime('00:00')
    .add({ minutes: Math.round(minute) })
    .toZonedDateTime(timeZone, { disambiguation: 'compatible' })
    .toInstant()
}

export function moveEvent(
  event: CalendarEvent,
  targetDate: string,
  targetMinute: number,
  timeZone = DEFAULT_TIME_ZONE,
): EventInput {
  if (event.allDay) {
    const days = Temporal.PlainDate.from(event.start).until(Temporal.PlainDate.from(event.end)).days
    return { ...asInput(event), start: targetDate, end: addDays(targetDate, days) }
  }
  const start = instantAtMinute(targetDate, targetMinute, timeZone)
  const duration =
    Temporal.Instant.from(event.end).epochMilliseconds -
    Temporal.Instant.from(event.start).epochMilliseconds
  return {
    ...asInput(event),
    start: start.toString(),
    end: start.add({ milliseconds: duration }).toString(),
  }
}

export function resizeEvent(
  event: CalendarEvent,
  targetMinute: number,
  timeZone = DEFAULT_TIME_ZONE,
): EventInput {
  if (event.allDay) return asInput(event)
  const start = Temporal.Instant.from(event.start)
  const date = start.toZonedDateTimeISO(timeZone).toPlainDate().toString()
  const proposedEnd = instantAtMinute(date, targetMinute, timeZone)
  const minimumEnd = start.add({ minutes: 15 })
  const end = Temporal.Instant.compare(proposedEnd, minimumEnd) < 0 ? minimumEnd : proposedEnd
  return { ...asInput(event), end: end.toString() }
}
