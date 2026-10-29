import { Temporal } from '@js-temporal/polyfill'
import { describe, expect, it } from 'vitest'
import { addDays, eventsByDate } from './calendar'
import { isSpanningEvent, layoutEventSpans, limitEventSpans } from './eventSpans'
import type { CalendarEvent } from './types'

const timeZone = 'America/Chicago'
const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'one',
  accountId: 'personal',
  calendarId: 'personal',
  title: 'A few days away',
  start: '2026-10-26',
  end: '2026-10-29',
  allDay: true,
  timeZone,
  ...overrides,
})

function layout(
  events: CalendarEvent[],
  startDate = '2026-10-25',
  zone = timeZone,
  includeDailyEvents = false,
) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(startDate, index))
  const grouped = eventsByDate(events, {
    startDate,
    endDate: addDays(startDate, 7),
    timeZone: zone,
  })
  return layoutEventSpans(days, grouped, zone, includeDailyEvents)
}

describe('spanning event classification', () => {
  it('includes single-day and multi-day all-day events', () => {
    expect(isSpanningEvent(event())).toBe(true)
    expect(isSpanningEvent(event({ end: '2026-10-27' }))).toBe(true)
  })

  it.each([
    ['2026-10-27T13:59:59.999999999Z', false],
    ['2026-10-27T14:00:00Z', false],
    ['2026-10-27T14:00:00.000000001Z', true],
    ['2026-10-27T15:00:00Z', true],
  ])('compares the full elapsed duration ending at %s', (end, expected) => {
    expect(isSpanningEvent(event({ allDay: false, start: '2026-10-26T14:00:00Z', end }))).toBe(
      expected,
    )
  })

  it.each([
    ['2026-03-07', false],
    ['2026-10-31', true],
  ])('uses elapsed hours across the DST transition starting %s', (date, expected) => {
    const start = Temporal.PlainDate.from(date).toPlainDateTime('12:00').toZonedDateTime(timeZone)
    expect(
      isSpanningEvent(
        event({
          allDay: false,
          start: start.toInstant().toString(),
          end: start.add({ days: 1 }).toInstant().toString(),
        }),
      ),
    ).toBe(expected)
  })
})

describe('event span layout', () => {
  it('wraps at the week boundary and preserves the exclusive all-day end', () => {
    const item = event({ start: '2026-10-30', end: '2026-11-03' })
    expect(layout([item])).toMatchObject([
      { start: 5, end: 7, row: 0, continuesBefore: false, continuesAfter: true },
    ])
    expect(layout([item], '2026-11-01')).toMatchObject([
      { start: 0, end: 2, row: 0, continuesBefore: true, continuesAfter: false },
    ])
  })

  it.each(['America/Los_Angeles', 'Pacific/Auckland'])('keeps all-day columns in %s', (zone) => {
    expect(layout([event()], '2026-10-25', zone)).toMatchObject([{ start: 1, end: 4 }])
  })

  it('uses the display zone and excludes a timed midnight end without losing precision', () => {
    const item = event({
      allDay: false,
      start: '2026-10-26T23:00:00.000000001Z',
      end: '2026-10-28T05:00:00Z',
    })
    expect(layout([item])).toMatchObject([{ start: 1, end: 3 }])
    expect(layout([item], '2026-10-25', 'Asia/Tokyo')).toMatchObject([{ start: 2, end: 4 }])
    expect(layout([{ ...item, end: '2026-10-28T05:00:00.000000001Z' }])).toMatchObject([
      { start: 1, end: 4 },
    ])
    expect(item.start).toBe('2026-10-26T23:00:00.000000001Z')
    expect(item.end).toBe('2026-10-28T05:00:00Z')
  })

  it('clips very long events to the visible row without expanding their duration', () => {
    const items = [
      event({ start: '1900-01-01', end: '9999-12-31' }),
      event({
        id: 'long-timed',
        allDay: false,
        start: '1900-01-01T00:00:00Z',
        end: '9999-12-31T00:00:00Z',
      }),
    ]
    const spans = layout(items)
    expect(spans).toHaveLength(2)
    expect(spans).toMatchObject([
      { start: 0, end: 7, row: 0, continuesBefore: true, continuesAfter: true },
      { start: 0, end: 7, row: 1, continuesBefore: true, continuesAfter: true },
    ])
    expect(layout([], '2026-10-25')).toEqual([])
    expect(layoutEventSpans([], new Map(), timeZone)).toEqual([])
  })

  it('packs multi-day bars first, shares free lanes, and stays stable when input is reordered', () => {
    const items = [
      event({ id: 'single', start: '2026-10-26', end: '2026-10-27' }),
      event({ id: 'overlap', start: '2026-10-27', end: '2026-10-30' }),
      event({ id: 'later', start: '2026-10-29', end: '2026-11-01' }),
      event({ id: 'long' }),
    ]
    const spans = layout(items)
    const rows = Object.fromEntries(spans.map((span) => [span.event.id, span.row]))
    expect(rows).toEqual({ long: 0, overlap: 1, later: 0, single: 1 })
    expect(layout([...items].reverse())).toEqual(spans)
    for (let column = 0; column < 7; column++) {
      const rows = spans
        .filter((span) => span.start <= column && span.end > column)
        .map((s) => s.row)
      expect(new Set(rows).size).toBe(rows.length)
    }
  })

  it('keeps events with matching resource IDs isolated by account and calendar', () => {
    const items = [event(), event({ accountId: 'work' }), event({ calendarId: 'family' })]
    const spans = layout(items)
    expect(spans).toHaveLength(3)
    expect(new Set(spans.map((span) => span.key)).size).toBe(3)
    expect(spans.map((span) => span.row)).toEqual([0, 1, 2])
    expect(layout([...items].reverse())).toEqual(spans)
  })

  it('only includes short overnight events as separate per-day entries when requested', () => {
    const item = event({
      allDay: false,
      start: '2026-10-27T04:00:00Z',
      end: '2026-10-27T07:00:00Z',
    })
    expect(layout([item])).toEqual([])
    expect(layout([item], '2026-10-25', timeZone, true)).toMatchObject([
      { start: 1, end: 2, spanning: false },
      { start: 2, end: 3, spanning: false },
    ])
  })
})

describe('month span overflow', () => {
  const items = [
    event({ id: 'top', start: '2026-10-25', end: '2026-11-01' }),
    event({ id: 'second', start: '2026-10-26', end: '2026-10-28' }),
    event({ id: 'extra', start: '2026-10-26', end: '2026-10-27' }),
    event({ id: 'uncrowded', start: '2026-10-28', end: '2026-10-29' }),
  ]

  it('keeps a bar whole and counts hidden events on every affected date', () => {
    const result = limitEventSpans(layout(items), 2, 7)
    expect(result.visible.map((span) => span.event.id)).toEqual(['top', 'uncrowded'])
    expect(result.hiddenCounts).toEqual([0, 2, 1, 0, 0, 0, 0])
  })

  it('keeps the overflow row available at a one-row capacity', () => {
    const result = limitEventSpans(layout(items), 1, 7)
    expect(result.visible).toEqual([])
    expect(result.hiddenCounts).toEqual([1, 3, 2, 2, 1, 1, 1])
  })

  it('does not hide entries on unrelated dates when only one day is crowded', () => {
    const spans = layout([
      event({ id: 'span', start: '2026-10-26', end: '2026-10-29' }),
      event({ id: 'busy', start: '2026-10-27', end: '2026-10-28' }),
      event({ id: 'quiet', start: '2026-10-25', end: '2026-10-26' }),
    ])
    const result = limitEventSpans(spans, 1, 7)
    expect(result.visible.map((span) => span.event.id)).toEqual(['quiet'])
    expect(result.hiddenCounts).toEqual([0, 1, 2, 1, 0, 0, 0])
  })

  it('shows every event again when the window has enough room', () => {
    const spans = layout(items)
    expect(limitEventSpans(spans, 3, 7)).toEqual({
      visible: spans,
      hiddenCounts: [0, 0, 0, 0, 0, 0, 0],
    })
  })
})
