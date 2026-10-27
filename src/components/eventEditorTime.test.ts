import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../domain/types'
import { dateTimeFields, resolveTimedEventRange } from './eventEditorTime'

function event(start: string, end: string): CalendarEvent {
  return {
    id: 'event',
    accountId: 'personal',
    calendarId: 'personal',
    title: 'An existing event',
    start,
    end,
    allDay: false,
    timeZone: 'America/Chicago',
  }
}

function fieldsFor(value: CalendarEvent) {
  const start = dateTimeFields(value.start, value.timeZone)
  const end = dateTimeFields(value.end, value.timeZone)
  return { startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time }
}

describe('event editor timed range resolution', () => {
  it('preserves the later repeated hour when only event metadata changes', () => {
    const value = event('2026-11-01T07:30:00Z', '2026-11-01T08:30:00Z')
    expect(fieldsFor(value).startTime).toBe('01:30')
    expect(resolveTimedEventRange(fieldsFor(value), value.timeZone, value)).toEqual({
      start: value.start,
      end: value.end,
    })
  })

  it('preserves an end in the later repeated hour independently of a changed start', () => {
    const value = event('2026-11-01T05:30:00Z', '2026-11-01T07:30:00Z')
    const fields = { ...fieldsFor(value), startTime: '00:45' }
    expect(resolveTimedEventRange(fields, value.timeZone, value)).toEqual({
      start: '2026-11-01T05:45:00Z',
      end: value.end,
    })
  })

  it('preserves a start in the later repeated hour independently of a changed end', () => {
    const value = event('2026-11-01T07:30:00Z', '2026-11-01T08:30:00Z')
    const fields = { ...fieldsFor(value), endTime: '02:45' }
    expect(resolveTimedEventRange(fields, value.timeZone, value)).toEqual({
      start: value.start,
      end: '2026-11-01T08:45:00Z',
    })
  })

  it('preserves seconds and fractional seconds on a title-only edit', () => {
    const value = event('2026-10-26T14:00:12.345Z', '2026-10-26T15:00:42.123456789Z')
    expect(resolveTimedEventRange(fieldsFor(value), value.timeZone, value)).toEqual({
      start: value.start,
      end: value.end,
    })
  })

  it('uses compatible fold resolution when the time is deliberately changed', () => {
    const value = event('2026-11-01T07:30:00Z', '2026-11-01T08:30:00Z')
    const fields = { ...fieldsFor(value), startTime: '01:45' }
    expect(resolveTimedEventRange(fields, value.timeZone, value).start).toBe('2026-11-01T06:45:00Z')
  })

  it('reinterprets the local controls when the named time zone changes', () => {
    const value = event('2026-10-26T14:00:12Z', '2026-10-26T15:00:42Z')
    expect(resolveTimedEventRange(fieldsFor(value), 'America/New_York', value)).toEqual({
      start: '2026-10-26T13:00:00Z',
      end: '2026-10-26T14:00:00Z',
    })
  })

  it('creates new timed events without attempting to preserve an all-day date', () => {
    const value = { ...event('2026-10-26', '2026-10-27'), allDay: true }
    const fields = {
      startDate: '2026-10-26',
      endDate: '2026-10-26',
      startTime: '09:00',
      endTime: '10:00',
    }
    expect(resolveTimedEventRange(fields, value.timeZone, value)).toEqual({
      start: '2026-10-26T14:00:00Z',
      end: '2026-10-26T15:00:00Z',
    })
  })

  it('rejects an edited end that is before a preserved start', () => {
    const value = event('2026-11-01T07:30:00Z', '2026-11-01T08:30:00Z')
    const fields = { ...fieldsFor(value), endTime: '01:45' }
    expect(() => resolveTimedEventRange(fields, value.timeZone, value)).toThrow(
      'The end time must be after the start time.',
    )
  })
})
