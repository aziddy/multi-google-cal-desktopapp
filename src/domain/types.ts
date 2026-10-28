export type CalendarView = 'day' | 'week' | 'month' | 'schedule' | '7days'
export type Theme = 'system' | 'light' | 'dark'

export interface Account {
  id: string
  name: string
  email: string
  initials: string
  color: string
  provider?: 'demo' | 'google'
  connectionStatus?: string
}

export interface Calendar {
  id: string
  accountId: string
  name: string
  color: string
  timeZone?: string
  accessRole?: 'freeBusyReader' | 'reader' | 'writer' | 'owner'
  provider?: 'demo' | 'google'
  primary?: boolean
  accountEmail?: string
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
  provider?: 'demo' | 'google'
  etag?: string
  recurringEventId?: string
  originalStart?: string
  htmlLink?: string
  capabilities?: { edit: boolean; delete: boolean; reason?: string }
  recurrence?: string[] | null
  seriesScheduleEditable?: boolean
  seriesScheduleReason?: string
}

export type EventInput = Pick<
  CalendarEvent,
  | 'accountId'
  | 'calendarId'
  | 'title'
  | 'start'
  | 'end'
  | 'allDay'
  | 'timeZone'
  | 'location'
  | 'description'
> & { recurrence?: string[] | null }

export type MutationScope = 'occurrence' | 'series'
export interface MutationOptions {
  event?: CalendarEvent
  scope?: MutationScope
  requestId?: string
}

/** Date-only boundaries in the display zone. The end is exclusive. */
export interface DateRange {
  startDate: string
  endDate: string
  timeZone: string
}

export interface CalendarRepository {
  listAccounts(): Promise<Account[]>
  listCalendars(): Promise<Calendar[]>
  listEvents(range?: DateRange): Promise<CalendarEvent[]>
  createEvent(input: EventInput, options?: MutationOptions): Promise<CalendarEvent>
  updateEvent(id: string, input: EventInput, options?: MutationOptions): Promise<CalendarEvent>
  deleteEvent(id: string, options?: MutationOptions): Promise<void>
  resetDemo(): Promise<void>
}
