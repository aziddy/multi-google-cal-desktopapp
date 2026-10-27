import { describe, expect, it } from 'vitest'
import { buildRecurrence, defaultRecurrence, parseRecurrence } from './recurrence'

describe('Google recurrence controls', () => {
  it('builds weekly intervals and count endings', () => {
    expect(
      buildRecurrence(
        {
          ...defaultRecurrence('2026-10-26'),
          frequency: 'WEEKLY',
          interval: 2,
          weekdays: ['WE', 'MO'],
          ending: 'count',
          count: 8,
        },
        '2026-10-26',
        false,
        'America/Chicago',
      ),
    ).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=8'])
  })
  it('keeps monthly and leap-day anchors instead of clamping invalid dates', () => {
    expect(
      buildRecurrence(
        { ...defaultRecurrence('2028-02-29'), frequency: 'YEARLY' },
        '2028-02-29',
        true,
        'Pacific/Kiritimati',
      ),
    ).toEqual(['RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=29;BYMONTH=2'])
    expect(
      buildRecurrence(
        { ...defaultRecurrence('2026-01-31'), frequency: 'MONTHLY' },
        '2026-01-31',
        true,
        'UTC',
      ),
    ).toEqual(['RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31'])
  })
  it('converts until endings using the series zone across DST while preserving all-day dates', () => {
    const rule = {
      ...defaultRecurrence('2026-10-26'),
      frequency: 'DAILY' as const,
      ending: 'until' as const,
      until: '2026-11-02',
    }
    expect(buildRecurrence(rule, '2026-10-26', false, 'America/Chicago')[0]).toContain(
      'UNTIL=20261103T055959Z',
    )
    expect(buildRecurrence(rule, '2026-10-26', true, 'Pacific/Kiritimati')[0]).toContain(
      'UNTIL=20261102',
    )
  })
  it('preserves complex imported patterns and rejects invalid endings', () => {
    expect(
      parseRecurrence(['RRULE:FREQ=MONTHLY;BYDAY=2MO'], '2026-10-26', 'America/Chicago'),
    ).toBeNull()
    expect(parseRecurrence(['RRULE:FREQ=DAILY', 'EXDATE:20261028'], '2026-10-26', 'UTC')).toBeNull()
    expect(
      parseRecurrence(['RRULE:FREQ=MONTHLY;BYMONTHDAY=31'], '2026-01-31', 'UTC')?.frequency,
    ).toBe('MONTHLY')
    expect(() =>
      buildRecurrence(
        { ...defaultRecurrence('2026-10-26'), frequency: 'WEEKLY', weekdays: [] },
        '2026-10-26',
        true,
        'UTC',
      ),
    ).toThrow('at least one weekday')
  })
})
