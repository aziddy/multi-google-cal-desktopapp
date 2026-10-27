import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRepository, type RepositoryStorage } from './repository'
import { createDemoSnapshot, type CalendarSnapshot } from './fixtures'
import type { EventInput } from '../domain/types'

const options = { today: '2026-10-26', timeZone: 'America/Chicago' }
const input: EventInput = {
  accountId: 'personal',
  calendarId: 'personal',
  title: 'New appointment',
  start: '2026-10-26T14:00:00Z',
  end: '2026-10-26T15:00:00Z',
  allDay: false,
  timeZone: options.timeZone,
}

const platform = vi.hoisted(() => ({ native: false, load: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => platform.native }))
vi.mock('@tauri-apps/plugin-store', () => ({ load: platform.load }))

function nativeStore(initial?: CalendarSnapshot) {
  let value: unknown = initial
  return {
    get: vi.fn(async () => value),
    set: vi.fn(async (_key: string, snapshot: unknown) => {
      value = structuredClone(snapshot)
    }),
    delete: vi.fn(async () => {
      value = undefined
    }),
    save: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
}

function memoryStorage(initial?: unknown) {
  let saved = initial
  let fail = false
  let writes = 0
  const storage: RepositoryStorage = {
    load: async () => structuredClone(saved),
    save: async (snapshot) => {
      if (fail) throw new Error('Disk full')
      saved = structuredClone(snapshot)
      writes++
    },
  }
  return {
    storage,
    value: () => saved as CalendarSnapshot,
    fail: (value: boolean) => {
      fail = value
    },
    writes: () => writes,
  }
}

describe('calendar repository', () => {
  beforeEach(() => {
    localStorage.clear()
    platform.native = false
    platform.load.mockReset()
  })

  it('initializes fictional calendars once and reloads saved changes', async () => {
    const disk = memoryStorage()
    const repo = createRepository({ ...options, storage: disk.storage })
    expect(await repo.listAccounts()).toHaveLength(2)
    expect(await repo.listCalendars()).toHaveLength(5)
    expect(disk.writes()).toBe(1)
    const added = await repo.createEvent(input)
    const reloaded = createRepository({ ...options, storage: disk.storage })
    expect((await reloaded.listEvents()).find((event) => event.id === added.id)).toEqual(added)
    expect(disk.writes()).toBe(2)
  })
  it('creates, updates, deletes, and resets events with persisted snapshots', async () => {
    const disk = memoryStorage()
    const repo = createRepository({ ...options, storage: disk.storage })
    const baseline = (await repo.listEvents()).length
    const added = await repo.createEvent(input)
    expect(
      await repo.updateEvent(added.id, { ...input, title: 'Updated appointment' }),
    ).toMatchObject({ title: 'Updated appointment', id: added.id })
    expect(disk.value().events.find((event) => event.id === added.id)?.title).toBe(
      'Updated appointment',
    )
    await repo.deleteEvent(added.id)
    expect(await repo.listEvents()).toHaveLength(baseline)
    await repo.createEvent(input)
    await repo.resetDemo()
    expect(await repo.listEvents()).toHaveLength(baseline)
    expect(disk.value().events.some((event) => event.title === input.title)).toBe(false)
  })
  it('does not mutate existing data after a save failure and allows retry', async () => {
    const disk = memoryStorage()
    const repo = createRepository({ ...options, storage: disk.storage })
    const baseline = await repo.listEvents()
    disk.fail(true)
    await expect(repo.createEvent(input)).rejects.toMatchObject({ code: 'SAVE_FAILED' })
    expect(await repo.listEvents()).toEqual(baseline)
    disk.fail(false)
    await repo.createEvent(input)
    expect(await repo.listEvents()).toHaveLength(baseline.length + 1)
  })
  it('serializes concurrent writes so neither edit is lost', async () => {
    const disk = memoryStorage()
    const repo = createRepository({ ...options, storage: disk.storage })
    const baseline = (await repo.listEvents()).length
    const [first, second] = await Promise.all([
      repo.createEvent({ ...input, title: 'First appointment' }),
      repo.createEvent({ ...input, title: 'Second appointment' }),
    ])
    expect(first.id).not.toBe(second.id)
    expect(disk.value().events).toHaveLength(baseline + 2)
    expect(
      (await repo.listEvents()).filter((event) => [first.id, second.id].includes(event.id)),
    ).toHaveLength(2)
  })
  it('isolates returned data from repository state', async () => {
    const disk = memoryStorage()
    const repo = createRepository({ ...options, storage: disk.storage })
    const accounts = await repo.listAccounts()
    accounts[0].name = 'Changed externally'
    expect((await repo.listAccounts())[0].name).toBe('Alex Morgan')
  })
  it('rejects invalid ownership, dates, and empty titles without writing', async () => {
    const disk = memoryStorage()
    const repo = createRepository({ ...options, storage: disk.storage })
    await repo.listEvents()
    for (const invalid of [
      { ...input, title: '  ' },
      { ...input, calendarId: 'work' },
      { ...input, end: input.start },
      { ...input, allDay: true },
      { ...input, timeZone: 'Invalid/Place' },
      { ...input, start: '2026-02-31', end: '2026-03-02', allDay: true },
    ])
      await expect(repo.createEvent(invalid)).rejects.toMatchObject({ code: 'INVALID_EVENT' })
    expect(disk.writes()).toBe(1)
  })
  it('reports corrupt data and recovers through explicit reset', async () => {
    const disk = memoryStorage({ version: 99 })
    const repo = createRepository({ ...options, storage: disk.storage })
    await expect(repo.listAccounts()).rejects.toMatchObject({
      code: 'CORRUPT_DATA',
      message: expect.stringContaining('Reset demo data'),
    })
    expect(disk.writes()).toBe(0)
    await repo.resetDemo()
    expect(await repo.listAccounts()).toHaveLength(2)
    expect(disk.value().version).toBe(1)
  })
  it('persists and reloads using the browser fallback', async () => {
    const repo = createRepository(options)
    const added = await repo.createEvent(input)
    expect(localStorage.length).toBe(1)
    const reloaded = createRepository(options)
    expect((await reloaded.listEvents()).some((event) => event.id === added.id)).toBe(true)
  })
  it('recovers malformed browser JSON only after explicit reset', async () => {
    localStorage.setItem('calendar-demo-v1', '{not json')
    const repo = createRepository(options)
    await expect(repo.listEvents()).rejects.toMatchObject({ code: 'CORRUPT_DATA' })
    expect(localStorage.getItem('calendar-demo-v1')).toBe('{not json')
    await repo.resetDemo()
    expect(await repo.listCalendars()).toHaveLength(5)
    expect(JSON.parse(localStorage.getItem('calendar-demo-v1')!)).toMatchObject({ version: 1 })
  })
  it('uses the native store with explicit persistence and restores its cache after save failure', async () => {
    platform.native = true
    const initial = createDemoSnapshot(options.today, options.timeZone)
    const store = nativeStore(initial)
    platform.load.mockResolvedValue(store)
    const repo = createRepository(options)
    await repo.listEvents()
    store.save.mockRejectedValueOnce(new Error('Disk full'))
    await expect(repo.createEvent(input)).rejects.toMatchObject({ code: 'SAVE_FAILED' })
    expect(await store.get()).toEqual(initial)
    expect(await repo.listEvents()).toEqual(initial.events)
    expect(platform.load).toHaveBeenCalledWith('calendar-demo.json', {
      autoSave: false,
      defaults: {},
    })
  })
  it('closes a corrupt native store to prevent destructive exit saves and supports explicit reset', async () => {
    platform.native = true
    const corrupt = nativeStore()
    corrupt.reload.mockRejectedValue(new Error('expected value at line 1 column 1'))
    const replacement = nativeStore()
    platform.load.mockResolvedValueOnce(corrupt).mockResolvedValueOnce(replacement)
    const repo = createRepository(options)
    await expect(repo.listEvents()).rejects.toMatchObject({ code: 'CORRUPT_DATA' })
    expect(corrupt.close).toHaveBeenCalledOnce()
    expect(corrupt.save).not.toHaveBeenCalled()
    await repo.resetDemo()
    expect(platform.load).toHaveBeenLastCalledWith('calendar-demo.json', {
      autoSave: false,
      defaults: {},
      createNew: true,
    })
    expect(await repo.listCalendars()).toHaveLength(5)
  })
  it('filters exclusive date ranges', async () => {
    const snapshot = createDemoSnapshot(options.today, options.timeZone)
    snapshot.events = [
      { ...input, id: 'inside' },
      { ...input, id: 'ends-at-start', start: '2026-10-26T04:00:00Z', end: '2026-10-26T05:00:00Z' },
      { ...input, id: 'starts-at-end', start: '2026-10-27T05:00:00Z', end: '2026-10-27T06:00:00Z' },
      { ...input, id: 'all-day', start: '2026-10-26', end: '2026-10-27', allDay: true },
      { ...input, id: 'previous-day', start: '2026-10-25', end: '2026-10-26', allDay: true },
    ]
    const disk = memoryStorage(snapshot)
    const repo = createRepository({ ...options, storage: disk.storage })
    expect(
      (
        await repo.listEvents({
          startDate: '2026-10-26',
          endDate: '2026-10-27',
          timeZone: 'America/Chicago',
        })
      ).map((event) => event.id),
    ).toEqual(['inside', 'all-day'])
  })
  it('uses the view zone for timed boundaries and preserves all-day dates at UTC+14', async () => {
    const snapshot = createDemoSnapshot(options.today, options.timeZone)
    snapshot.events = [
      { ...input, id: 'timed', start: '2026-10-25T10:30:00Z', end: '2026-10-25T11:30:00Z' },
      { ...input, id: 'all-day', start: '2026-10-26', end: '2026-10-27', allDay: true },
      { ...input, id: 'previous', start: '2026-10-25', end: '2026-10-26', allDay: true },
    ]
    const repo = createRepository({ ...options, storage: memoryStorage(snapshot).storage })
    expect(
      (
        await repo.listEvents({
          startDate: '2026-10-26',
          endDate: '2026-10-27',
          timeZone: 'Pacific/Kiritimati',
        })
      ).map((event) => event.id),
    ).toEqual(['timed', 'all-day'])
  })
})
