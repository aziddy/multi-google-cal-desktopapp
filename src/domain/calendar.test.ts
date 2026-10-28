import { describe, expect, it } from 'vitest'
import { Temporal } from '@js-temporal/polyfill'
import {
  addDays,
  addMonths,
  canChangeEvent,
  eventDates,
  formatDate,
  monthDays,
  moveEvent,
  resizeEvent,
  startOfWeek,
  timedSegments,
  utcMonthBuckets,
  viewRange,
} from './calendar'
import type { CalendarEvent } from './types'

const zone = 'America/Chicago'
const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'one',
  accountId: 'personal',
  calendarId: 'personal',
  title: 'A meeting',
  start: '2026-10-26T14:00:00Z',
  end: '2026-10-26T15:00:00Z',
  allDay: false,
  timeZone: zone,
  ...overrides,
})

describe('date navigation', () => {
  it('requires explicit capabilities for Google events', () => {
    expect(canChangeEvent(event(), 'edit')).toBe(true)
    expect(canChangeEvent(event({ provider: 'google' }), 'edit')).toBe(false)
    expect(
      canChangeEvent(
        event({ provider: 'google', capabilities: { edit: true, delete: false } }),
        'edit',
      ),
    ).toBe(true)
    expect(
      canChangeEvent(
        event({ provider: 'google', capabilities: { edit: true, delete: false } }),
        'delete',
      ),
    ).toBe(false)
  })
  it('covers the full visible range and the UTC months needed for all-day and timed events', () => {
    expect(viewRange('2026-10-26', 'month', zone)).toEqual({
      startDate: '2026-09-27',
      endDate: '2026-11-08',
      timeZone: zone,
    })
    expect(viewRange('2026-10-26', 'schedule', zone).endDate).toBe('2026-11-25')
    expect(
      utcMonthBuckets({
        startDate: '2026-03-01',
        endDate: '2026-03-02',
        timeZone: 'Pacific/Kiritimati',
      }).map((b) => b.startDate),
    ).toEqual(['2026-02-01', '2026-03-01'])
    expect(
      utcMonthBuckets({ startDate: '2026-03-08', endDate: '2026-03-09', timeZone: zone }),
    ).toEqual([{ startDate: '2026-03-01', endDate: '2026-04-01', timeZone: 'UTC' }])
  })
  it('clamps month navigation and handles leap years', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('anchors 7 days on the selected date and includes the final day in sync coverage', () => {
    const range = viewRange('2026-10-27', '7days', zone)
    expect(range).toEqual({ startDate: '2026-10-27', endDate: '2026-11-03', timeZone: zone })
    expect(viewRange('2026-10-27', 'week', zone)).toEqual({
      startDate: '2026-10-25',
      endDate: '2026-11-01',
      timeZone: zone,
    })
    expect(utcMonthBuckets(range)).toEqual([
      { startDate: '2026-10-01', endDate: '2026-11-01', timeZone: 'UTC' },
      { startDate: '2026-11-01', endDate: '2026-12-01', timeZone: 'UTC' },
    ])
    expect(viewRange('2026-12-29', '7days', zone).endDate).toBe('2027-01-05')
  })
  it.each([
    ['2026-03-06', '2026-03-13', 167],
    ['2026-10-27', '2026-11-03', 169],
  ])('keeps seven local dates across DST starting %s', (date, endDate, hours) => {
    const range = viewRange(date, '7days', zone)
    expect(range.startDate).toBe(date)
    expect(range.endDate).toBe(endDate)
    const start = Temporal.PlainDate.from(range.startDate).toZonedDateTime(zone)
    const end = Temporal.PlainDate.from(range.endDate).toZonedDateTime(zone)
    expect(start.until(end, { largestUnit: 'hours' }).hours).toBe(hours)
  })
  it('returns six complete Sunday-first weeks', () => {
    const dates = monthDays('2026-10-26')
    expect(dates).toHaveLength(42)
    expect(dates[0]).toBe('2026-09-27')
    expect(dates[41]).toBe('2026-11-07')
    expect(startOfWeek('2026-10-25')).toBe('2026-10-25')
    expect(startOfWeek('2026-10-31')).toBe('2026-10-25')
  })
  it('formats date-only values without shifting the calendar date', () => {
    expect(formatDate('2026-10-26', { day: 'numeric' }, 'America/Los_Angeles')).toBe('26')
    expect(formatDate('2026-10-26', { day: 'numeric' }, 'Pacific/Auckland')).toBe('26')
  })
})

describe('exclusive event ranges', () => {
  it('keeps all-day dates independent of time zones and excludes the end date', () => {
    const item = event({ start: '2026-10-26', end: '2026-10-29', allDay: true })
    expect(eventDates(item, 'Pacific/Auckland')).toEqual(['2026-10-26', '2026-10-27', '2026-10-28'])
    expect(eventDates(item, 'America/Los_Angeles')).toHaveLength(3)
  })
  it('excludes a timed midnight end and includes cross-midnight events', () => {
    expect(
      eventDates(event({ start: '2026-10-27T03:00:00Z', end: '2026-10-27T05:00:00Z' }), zone),
    ).toEqual(['2026-10-26'])
    expect(
      eventDates(event({ start: '2026-10-27T04:30:00Z', end: '2026-10-27T05:30:00Z' }), zone),
    ).toEqual(['2026-10-26', '2026-10-27'])
  })
})

describe('timed layout', () => {
  it('packs connected overlaps and starts a new group at touching boundaries', () => {
    const items = [
      event({ id: 'a', start: '2026-10-26T14:00:00Z', end: '2026-10-26T15:00:00Z' }),
      event({ id: 'b', start: '2026-10-26T14:30:00Z', end: '2026-10-26T16:00:00Z' }),
      event({ id: 'c', start: '2026-10-26T15:00:00Z', end: '2026-10-26T15:30:00Z' }),
      event({ id: 'd', start: '2026-10-26T16:00:00Z', end: '2026-10-26T17:00:00Z' }),
    ]
    const segments = timedSegments(items, '2026-10-26', zone)
    expect(segments.map(({ column, columns }) => [column, columns])).toEqual([
      [0, 2],
      [1, 2],
      [0, 2],
      [0, 1],
    ])
    expect(segments[0].startMinute).toBe(540)
    expect(segments[0].endMinute).toBe(600)
  })
  it('clips midnight-spanning events and ignores all-day events', () => {
    const segments = timedSegments(
      [
        event({ start: '2026-10-27T04:30:00Z', end: '2026-10-27T06:00:00Z' }),
        event({ id: 'all', start: '2026-10-26', end: '2026-10-27', allDay: true }),
      ],
      '2026-10-26',
      zone,
    )
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ startMinute: 1410, endMinute: 1440 })
  })
  it('keeps events during a repeated DST hour visible', () => {
    const segments = timedSegments(
      [event({ start: '2026-11-01T06:30:00Z', end: '2026-11-01T07:30:00Z' })],
      '2026-11-01',
      zone,
    )
    expect(segments[0]).toMatchObject({ startMinute: 90, endMinute: 150 })
  })
})

describe('event movement and resizing', () => {
  it('preserves elapsed duration across the spring-forward transition', () => {
    const moved = moveEvent(event(), '2026-03-08', 90, zone)
    expect(moved.start).toBe('2026-03-08T07:30:00Z')
    expect(moved.end).toBe('2026-03-08T08:30:00Z')
    expect(Temporal.Instant.from(moved.end).toZonedDateTimeISO(zone).hour).toBe(3)
    expect(moved).not.toHaveProperty('id')
  })
  it('resolves nonexistent wall-clock times and preserves all-day span', () => {
    const moved = moveEvent(event(), '2026-03-08', 150, zone)
    expect(moved.start).toBe('2026-03-08T08:30:00Z')
    expect(
      moveEvent(
        event({ start: '2026-10-26', end: '2026-10-29', allDay: true }),
        '2026-11-01',
        0,
        zone,
      ),
    ).toMatchObject({ start: '2026-11-01', end: '2026-11-04' })
  })
  it('uses local time when resizing and enforces a minimum duration', () => {
    expect(resizeEvent(event(), 660, zone).end).toBe('2026-10-26T16:00:00Z')
    expect(resizeEvent(event(), 300, zone).end).toBe('2026-10-26T14:15:00Z')
  })
})
