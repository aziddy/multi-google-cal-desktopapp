import type { CalendarEvent } from './types'

export function eventTime(event: CalendarEvent, timeZone: string, end = false): string {
  if (event.allDay) return 'All day'
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  })
    .format(new Date(end ? event.end : event.start))
    .toLowerCase()
    .replace(':00', '')
    .replace(' ', '')
}
