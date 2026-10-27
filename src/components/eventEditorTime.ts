import { Temporal } from '@js-temporal/polyfill'
import type { CalendarEvent } from '../domain/types'

export interface EventEditorDateTimeFields {
  startDate: string
  endDate: string
  startTime: string
  endTime: string
}

export function dateTimeFields(instant: string, timeZone: string) {
  const value = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone)
  return {
    date: value.toPlainDate().toString(),
    time: value.toPlainTime().toString({ smallestUnit: 'minute' }),
  }
}

/** Minute-resolution controls must not discard an unchanged instant's fold or sub-minute precision. */
export function resolveTimedEventRange(
  fields: EventEditorDateTimeFields,
  timeZone: string,
  event?: CalendarEvent,
) {
  const canPreserve = event && !event.allDay && event.timeZone === timeZone
  function resolve(date: string, time: string, original?: string) {
    if (canPreserve && original) {
      const displayed = dateTimeFields(original, timeZone)
      if (displayed.date === date && displayed.time === time) return original
    }
    return Temporal.PlainDateTime.from(`${date}T${time}`)
      .toZonedDateTime(timeZone)
      .toInstant()
      .toString()
  }
  const start = resolve(fields.startDate, fields.startTime, event?.start)
  const end = resolve(fields.endDate, fields.endTime, event?.end)
  if (Temporal.Instant.compare(Temporal.Instant.from(end), Temporal.Instant.from(start)) <= 0) {
    throw new Error('The end time must be after the start time.')
  }
  return { start, end }
}
