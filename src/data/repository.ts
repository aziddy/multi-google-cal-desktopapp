import { Temporal } from '@js-temporal/polyfill'
import { isTauri } from '@tauri-apps/api/core'
import type { CalendarRepository, CalendarEvent, EventInput, DateRange } from '../domain/types'
import { createDemoSnapshot, type CalendarSnapshot } from './fixtures'
import { googleRepository } from './googleRepository'

const STORAGE_KEY = 'calendar-demo-v1'

export class RepositoryError extends Error {
  constructor(
    public readonly code:
      'STORAGE_UNAVAILABLE' | 'CORRUPT_DATA' | 'SAVE_FAILED' | 'INVALID_EVENT' | 'NOT_FOUND',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RepositoryError'
  }
}

/** One snapshot is the persistence transaction boundary. */
export interface RepositoryStorage {
  load(): Promise<unknown>
  save(snapshot: CalendarSnapshot): Promise<void>
}

async function defaultStorage(): Promise<RepositoryStorage> {
  if (isTauri()) {
    const { load } = await import('@tauri-apps/plugin-store')
    let store: Awaited<ReturnType<typeof load>> | undefined
    let recoveryError: RepositoryError | undefined
    const open = async () =>
      (store ??= await load('calendar-demo.json', { autoSave: false, defaults: {} }))
    return {
      load: async () => {
        if (recoveryError) throw recoveryError
        const current = await open()
        try {
          // Initial plugin loading ignores file errors. Explicit reload surfaces corruption.
          await current.reload({ ignoreDefaults: true })
        } catch (cause) {
          if (!/os error 2\b|no such file|cannot find the file/i.test(String(cause))) {
            recoveryError = new RepositoryError(
              'CORRUPT_DATA',
              'Saved demo data could not be read. Use “Reset demo data” in Settings to restore the sample calendars.',
              { cause },
            )
            // Plugin-store saves open resources on app exit, even with autoSave disabled.
            // Closing prevents an unreadable file from being replaced with an empty cache.
            await current.close()
            store = undefined
            throw recoveryError
          }
        }
        return current.get(STORAGE_KEY)
      },
      save: async (snapshot) => {
        if (recoveryError) {
          store = await load('calendar-demo.json', {
            autoSave: false,
            defaults: {},
            createNew: true,
          })
        } else if (!store) {
          try {
            await open()
          } catch {
            // Only explicit reset can reach save without a successful load.
            store = await load('calendar-demo.json', {
              autoSave: false,
              defaults: {},
              createNew: true,
            })
          }
        }
        const previous = await store!.get(STORAGE_KEY)
        try {
          await store!.set(STORAGE_KEY, snapshot)
          await store!.save()
          recoveryError = undefined
        } catch (cause) {
          // Keep the plugin's exit-save cache consistent with the last committed snapshot.
          if (previous === undefined) await store!.delete(STORAGE_KEY)
          else await store!.set(STORAGE_KEY, previous)
          throw cause
        }
      },
    }
  }
  return {
    load: async () => {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw === null) return undefined
      try {
        return JSON.parse(raw) as unknown
      } catch (cause) {
        throw new RepositoryError(
          'CORRUPT_DATA',
          'Saved demo data could not be read. Use “Reset demo data” in Settings to restore the sample calendars.',
          { cause },
        )
      }
    },
    save: async (snapshot) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
    },
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validateInput(value: unknown, snapshot: CalendarSnapshot): EventInput {
  if (
    !record(value) ||
    !text(value.title) ||
    !text(value.accountId) ||
    !text(value.calendarId) ||
    typeof value.allDay !== 'boolean' ||
    !text(value.start) ||
    !text(value.end) ||
    !text(value.timeZone)
  ) {
    throw new RepositoryError(
      'INVALID_EVENT',
      'Add a title, calendar, and valid start and end times before saving.',
    )
  }
  if (
    !snapshot.calendars.some(
      (calendar) => calendar.id === value.calendarId && calendar.accountId === value.accountId,
    )
  ) {
    throw new RepositoryError(
      'INVALID_EVENT',
      'Choose a calendar that belongs to the selected account.',
    )
  }
  if (
    (value.location !== undefined && typeof value.location !== 'string') ||
    (value.description !== undefined && typeof value.description !== 'string')
  ) {
    throw new RepositoryError('INVALID_EVENT', 'Location and description must be text.')
  }
  try {
    Temporal.Now.zonedDateTimeISO(value.timeZone)
    if (value.allDay) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value.start) || !/^\d{4}-\d{2}-\d{2}$/.test(value.end))
        throw new Error('Invalid date')
      if (
        Temporal.PlainDate.compare(
          Temporal.PlainDate.from(value.start),
          Temporal.PlainDate.from(value.end),
        ) >= 0
      )
        throw new Error('Invalid range')
    } else if (
      Temporal.Instant.compare(
        Temporal.Instant.from(value.start),
        Temporal.Instant.from(value.end),
      ) >= 0
    )
      throw new Error('Invalid range')
  } catch (cause) {
    throw new RepositoryError(
      'INVALID_EVENT',
      'Choose valid dates and a time zone. The end must be after the start.',
      { cause },
    )
  }
  return {
    accountId: value.accountId,
    calendarId: value.calendarId,
    title: value.title.trim(),
    start: value.start,
    end: value.end,
    allDay: value.allDay,
    timeZone: value.timeZone,
    ...(value.location !== undefined && { location: value.location as string }),
    ...(value.description !== undefined && { description: value.description as string }),
  }
}

function validateSnapshot(value: unknown): CalendarSnapshot {
  try {
    if (
      !record(value) ||
      value.version !== 1 ||
      !Array.isArray(value.accounts) ||
      !Array.isArray(value.calendars) ||
      !Array.isArray(value.events)
    )
      throw new Error('Invalid schema')
    const snapshot = value as unknown as CalendarSnapshot
    const accountIds = new Set<string>()
    for (const account of snapshot.accounts) {
      if (
        !record(account) ||
        !text(account.id) ||
        accountIds.has(account.id) ||
        !text(account.name) ||
        !text(account.email) ||
        !text(account.initials) ||
        !text(account.color)
      )
        throw new Error('Invalid account')
      accountIds.add(account.id)
    }
    const calendarIds = new Set<string>()
    for (const calendar of snapshot.calendars) {
      const key = `${calendar.accountId}:${calendar.id}`
      if (
        !record(calendar) ||
        !text(calendar.id) ||
        !text(calendar.accountId) ||
        !accountIds.has(calendar.accountId) ||
        calendarIds.has(key) ||
        !text(calendar.name) ||
        !text(calendar.color)
      )
        throw new Error('Invalid calendar')
      calendarIds.add(key)
    }
    const eventIds = new Set<string>()
    for (const event of snapshot.events) {
      if (!record(event) || !text(event.id) || eventIds.has(event.id))
        throw new Error('Invalid event')
      eventIds.add(event.id)
      validateInput(event, snapshot)
    }
    return clone(snapshot)
  } catch (cause) {
    throw new RepositoryError(
      'CORRUPT_DATA',
      'Saved demo data is incomplete or incompatible. Use “Reset demo data” in Settings to restore the sample calendars.',
      { cause },
    )
  }
}

function overlaps(event: CalendarEvent, range?: DateRange): boolean {
  if (!range) return true
  if (event.allDay) return event.start < range.endDate && event.end > range.startDate
  const boundary = (date: string) =>
    Temporal.PlainDate.from(date).toZonedDateTime(range.timeZone).toInstant()
  return (
    Temporal.Instant.compare(Temporal.Instant.from(event.start), boundary(range.endDate)) < 0 &&
    Temporal.Instant.compare(Temporal.Instant.from(event.end), boundary(range.startDate)) > 0
  )
}

export function createRepository(
  options: { storage?: RepositoryStorage; today?: string; timeZone?: string } = {},
): CalendarRepository {
  let snapshot: CalendarSnapshot | undefined
  let loading: Promise<CalendarSnapshot> | undefined
  let adapter: RepositoryStorage | undefined = options.storage
  let queue: Promise<unknown> = Promise.resolve()
  const fresh = () => createDemoSnapshot(options.today, options.timeZone)
  const storage = async () => {
    try {
      return (adapter ??= await defaultStorage())
    } catch (cause) {
      throw new RepositoryError(
        'STORAGE_UNAVAILABLE',
        'Calendar storage is unavailable. Allow local storage or restart the app, then try again.',
        { cause },
      )
    }
  }
  const persist = async (next: CalendarSnapshot) => {
    try {
      await (await storage()).save(clone(next))
    } catch (cause) {
      if (cause instanceof RepositoryError) throw cause
      throw new RepositoryError(
        'SAVE_FAILED',
        'Your change could not be saved. Check available disk space and storage permissions, then try again. Your previous data is unchanged.',
        { cause },
      )
    }
    snapshot = next
  }
  const load = async (): Promise<CalendarSnapshot> => {
    if (snapshot) return snapshot
    if (!loading) {
      loading = (async () => {
        let saved: unknown
        try {
          saved = await (await storage()).load()
        } catch (cause) {
          if (cause instanceof RepositoryError) throw cause
          throw new RepositoryError(
            'STORAGE_UNAVAILABLE',
            'Calendar storage could not be opened. Restart the app or use “Reset demo data” in Settings to recover.',
            { cause },
          )
        }
        if (saved !== undefined && saved !== null) snapshot = validateSnapshot(saved)
        else await persist(fresh())
        return snapshot!
      })()
      loading.catch(() => {
        loading = undefined
      })
    }
    return loading
  }
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation)
    queue = next.catch(() => undefined)
    return next
  }
  const read = () => serial(load)
  return {
    listAccounts: async () => clone((await read()).accounts),
    listCalendars: async () => clone((await read()).calendars),
    listEvents: async (range) =>
      clone((await read()).events.filter((event) => overlaps(event, range))),
    createEvent: (input) =>
      serial(async () => {
        const current = await load()
        const event: CalendarEvent = { ...validateInput(input, current), id: crypto.randomUUID() }
        await persist({ ...current, events: [...current.events, event] })
        return clone(event)
      }),
    updateEvent: (id, input) =>
      serial(async () => {
        const current = await load()
        if (!current.events.some((event) => event.id === id))
          throw new RepositoryError(
            'NOT_FOUND',
            'This event no longer exists. Close the editor and refresh your calendar.',
          )
        const event: CalendarEvent = { ...validateInput(input, current), id }
        await persist({
          ...current,
          events: current.events.map((item) => (item.id === id ? event : item)),
        })
        return clone(event)
      }),
    deleteEvent: (id) =>
      serial(async () => {
        const current = await load()
        if (!current.events.some((event) => event.id === id))
          throw new RepositoryError(
            'NOT_FOUND',
            'This event no longer exists. Refresh your calendar to see the latest events.',
          )
        await persist({ ...current, events: current.events.filter((event) => event.id !== id) })
      }),
    resetDemo: () =>
      serial(async () => {
        await persist(fresh())
        loading = undefined
      }),
  }
}

export const demoRepository = createRepository()
export const dataSource = isTauri() ? 'google' : 'demo'
export const repository: CalendarRepository =
  dataSource === 'google' ? googleRepository : demoRepository
