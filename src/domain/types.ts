export type CalendarView = 'day' | 'week' | 'month' | 'schedule'
export type Theme = 'system' | 'light' | 'dark'

export interface Account {
  id: string
  name: string
  email: string
  initials: string
  color: string
}

export interface Calendar {
  id: string
  accountId: string
  name: string
  color: string
}

/** All-day start/end are YYYY-MM-DD with an exclusive end. Timed values are ISO instants. */
export interface CalendarEvent {
  id: string
  accountId: string
  calendarId: string
  title: string
  start: string
  end: string
  allDay: boolean
  timeZone: string
  location?: string
  description?: string
}

export type EventInput = Omit<CalendarEvent, 'id'>

export interface DateRange {
  start: string
  end: string
}

export interface CalendarRepository {
  listAccounts(): Promise<Account[]>
  listCalendars(): Promise<Calendar[]>
  listEvents(range?: DateRange): Promise<CalendarEvent[]>
  createEvent(input: EventInput): Promise<CalendarEvent>
  updateEvent(id: string, input: EventInput): Promise<CalendarEvent>
  deleteEvent(id: string): Promise<void>
  resetDemo(): Promise<void>
}
