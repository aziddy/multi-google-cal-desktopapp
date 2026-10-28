import { invoke } from '@tauri-apps/api/core'
import { Temporal } from '@js-temporal/polyfill'
import type {
  Account,
  Calendar,
  CalendarEvent,
  CalendarRepository,
  DateRange,
  EventInput,
  MutationOptions,
} from '../domain/types'

export interface SyncStatus {
  accountId: string
  calendarId: string
  lastSuccess: number | null
  error: string | null
  retryAt: number
  coverage: { startDate: string; endDate: string; complete: boolean; fetchedAt: number | null }[]
}
export type CredentialStorage = 'local_file' | 'os_store'

export interface GoogleSnapshot {
  credentialStorage: CredentialStorage
  client: { clientId: string; projectId: string } | null
  accounts: Account[]
  calendars: Calendar[]
  events: CalendarEvent[]
  syncStatus: SyncStatus[]
  connecting: boolean
  pendingMutations: number
  pendingWrites?: {
    requestId: string
    accountId: string
    operation: string
    title: string
    status: string
  }[]
}
export class GoogleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'GoogleError'
  }
}
async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && 'message' in cause)
      throw new GoogleError(String(cause.code), String(cause.message))
    throw new GoogleError(
      'NATIVE_FAILED',
      typeof cause === 'string'
        ? cause
        : 'The native Google service could not be reached. Restart the app.',
    )
  }
}

export function changedFields(original: CalendarEvent, input: EventInput): Record<string, unknown> {
  if (original.calendarId !== input.calendarId || original.accountId !== input.accountId)
    throw new GoogleError(
      'INVALID_EVENT',
      'Moving Google events between calendars is not supported.',
    )
  const changes: Record<string, unknown> = {}
  if (input.title !== original.title) changes.title = input.title
  for (const field of ['description', 'location'] as const)
    if ((input[field] ?? '') !== (original[field] ?? '')) changes[field] = input[field] || null
  if (
    ['start', 'end', 'allDay', 'timeZone'].some(
      (field) => input[field as keyof EventInput] !== original[field as keyof CalendarEvent],
    )
  )
    changes.timing = {
      start: input.start,
      end: input.end,
      allDay: input.allDay,
      timeZone: input.timeZone,
    }
  if (
    input.recurrence !== undefined &&
    JSON.stringify(input.recurrence ?? []) !== JSON.stringify(original.recurrence ?? [])
  )
    changes.recurrence = input.recurrence
  return changes
}

/** Tokens and raw Google resource metadata never cross this boundary. */
export class GoogleRepository implements CalendarRepository {
  private epoch = 0
  async snapshot(): Promise<GoogleSnapshot> {
    const epoch = this.epoch
    const snapshot = await native<GoogleSnapshot>('google_snapshot')
    return epoch === this.epoch ? snapshot : this.snapshot()
  }
  async importClient(useSaved = false) {
    const result = await native<GoogleSnapshot>('google_import_client', { useSaved })
    this.epoch++
    return result
  }
  async setCredentialStorage(storage: CredentialStorage) {
    this.epoch++
    try {
      return await native<GoogleSnapshot>('google_set_credential_storage', { storage })
    } finally {
      this.epoch++
    }
  }
  async connect(reconnect?: string) {
    const result = await native<GoogleSnapshot>('google_connect', { reconnect: reconnect ?? null })
    this.epoch++
    return result
  }
  cancelConnect() {
    return native<void>('google_cancel_connect')
  }
  async retryCredentials(accountId: string) {
    const result = await native<GoogleSnapshot>('google_retry_credentials', { accountId })
    this.epoch++
    return result
  }
  recoverPending() {
    return native<GoogleSnapshot>('google_recover_pending')
  }
  async retryPending(requestId: string) {
    const result = await native<GoogleSnapshot>('google_retry_pending', { requestId })
    this.epoch++
    return result
  }
  async disconnect(accountId: string) {
    this.epoch++
    const result = await native<GoogleSnapshot>('google_disconnect', { accountId })
    this.epoch++
    return result
  }
  async refreshAccounts() {
    const result = await native<GoogleSnapshot>('google_refresh_accounts')
    this.epoch++
    return result
  }
  sync(calendarId: string, buckets: DateRange[], force = false) {
    return native<void>('google_sync', {
      calendarId,
      buckets,
      refreshCalendars: false,
      force,
    })
  }
  series(eventId: string) {
    return native<CalendarEvent>('google_series', { eventId })
  }
  openEvent(eventId: string) {
    return native<void>('google_open_event', { eventId })
  }
  async listAccounts() {
    return (await this.snapshot()).accounts
  }
  async listCalendars() {
    return (await this.snapshot()).calendars
  }
  async listEvents(range?: DateRange) {
    const events = (await this.snapshot()).events
    if (!range) return events
    const start = Temporal.PlainDate.from(range.startDate)
      .toZonedDateTime(range.timeZone)
      .toInstant()
    const end = Temporal.PlainDate.from(range.endDate).toZonedDateTime(range.timeZone).toInstant()
    return events.filter((event) =>
      event.allDay
        ? event.start < range.endDate && event.end > range.startDate
        : Temporal.Instant.compare(Temporal.Instant.from(event.start), end) < 0 &&
          Temporal.Instant.compare(Temporal.Instant.from(event.end), start) > 0,
    )
  }
  async createEvent(input: EventInput, options?: MutationOptions): Promise<CalendarEvent> {
    const requestId = options?.requestId ?? crypto.randomUUID()
    const event = await native<CalendarEvent>('google_mutate', {
      mutation: {
        operation: 'create',
        calendarId: input.calendarId,
        eventId: null,
        requestId,
        expectedEtag: null,
        scope: 'series',
        input,
        changes: null,
      },
    })
    this.epoch++
    return event
  }
  async updateEvent(
    id: string,
    input: EventInput,
    options?: MutationOptions,
  ): Promise<CalendarEvent> {
    const original = options?.event ?? (await this.listEvents()).find((event) => event.id === id)
    if (!original) throw new GoogleError('NOT_FOUND', 'Reload this event before editing.')
    const changes = changedFields(original, input)
    if (!Object.keys(changes).length) return original
    const event = await native<CalendarEvent>('google_mutate', {
      mutation: {
        operation: 'update',
        calendarId: original.calendarId,
        eventId: id,
        requestId: options?.requestId ?? crypto.randomUUID(),
        expectedEtag: original.etag,
        scope: options?.scope ?? 'occurrence',
        input: null,
        changes,
      },
    })
    this.epoch++
    return event
  }
  async deleteEvent(id: string, options?: MutationOptions) {
    const original = options?.event ?? (await this.listEvents()).find((event) => event.id === id)
    if (!original) throw new GoogleError('NOT_FOUND', 'Reload this event before deleting.')
    await native('google_mutate', {
      mutation: {
        operation: 'delete',
        calendarId: original.calendarId,
        eventId: id,
        requestId: crypto.randomUUID(),
        expectedEtag: original.etag,
        scope: options?.scope ?? 'occurrence',
        input: null,
        changes: null,
      },
    })
    this.epoch++
  }
  async resetDemo(): Promise<void> {
    throw new GoogleError('INVALID_OPERATION', 'Switch to browser demo mode to reset sample data.')
  }
}
export const googleRepository = new GoogleRepository()
