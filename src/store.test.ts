import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({
  getItem: vi.fn<() => Promise<string | null>>(),
  setItem: vi.fn<() => Promise<void>>(),
  removeItem: vi.fn<() => Promise<void>>(),
}))

vi.mock('./data/preferences', () => ({ preferenceStorage: storage }))

async function hydrateStore(saved?: Record<string, unknown>) {
  storage.getItem.mockResolvedValue(saved ? JSON.stringify({ state: saved, version: 0 }) : null)
  const stores = await import('./store')
  await stores.usePreferences.persist.rehydrate()
  return stores
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-27T02:00:00Z'))
  storage.getItem.mockReset().mockResolvedValue(null)
  storage.setItem.mockReset().mockResolvedValue(undefined)
  storage.removeItem.mockReset().mockResolvedValue(undefined)
})

afterEach(() => vi.useRealTimers())

describe('persisted display preferences', () => {
  it('hydrates and resets today in the saved display zone', async () => {
    const { usePreferences } = await hydrateStore({
      timeZone: 'Asia/Tokyo',
      view: 'day',
      theme: 'dark',
    })
    expect(usePreferences.getState()).toMatchObject({
      date: '2026-10-27',
      timeZone: 'Asia/Tokyo',
      view: 'day',
      theme: 'dark',
    })
    await usePreferences.getState().setDate('2020-01-01')
    await usePreferences.getState().toggleCalendar('work')
    await usePreferences.getState().reset()
    expect(usePreferences.getState()).toMatchObject({
      date: '2026-10-27',
      timeZone: 'Asia/Tokyo',
      view: 'week',
      hiddenCalendarIds: [],
    })
  })

  it('ignores invalid saved zones and enum values instead of breaking rendering', async () => {
    const { usePreferences } = await hydrateStore({
      timeZone: 'Invalid/Planet',
      view: 'broken-view',
      theme: 'neon',
      hiddenCalendarIds: ['work', null, 42],
      sidebarOpen: 'yes',
    })
    const { DEFAULT_TIME_ZONE, todayDate } = await import('./domain/calendar')
    expect(usePreferences.getState()).toMatchObject({
      date: todayDate(DEFAULT_TIME_ZONE),
      timeZone: DEFAULT_TIME_ZONE,
      view: 'week',
      theme: 'system',
      hiddenCalendarIds: ['work'],
      sidebarOpen: true,
    })
  })

  it('reports quota failures separately while keeping setters usable and permits retry', async () => {
    const { usePreferences, usePreferencePersistence } = await hydrateStore()
    storage.setItem.mockRejectedValueOnce(
      new DOMException('Storage quota exceeded', 'QuotaExceededError'),
    )
    await expect(
      Promise.resolve(usePreferences.getState().setTheme('dark')),
    ).resolves.toBeUndefined()
    expect(usePreferences.getState().theme).toBe('dark')
    expect(usePreferencePersistence.getState().error).toMatch(/could not be saved|quota/i)
    await usePreferences.setState({})
    expect(usePreferencePersistence.getState().error).toBeNull()
    expect(storage.setItem).toHaveBeenLastCalledWith(
      'multi-calendar-preferences-v1',
      expect.stringContaining('"theme":"dark"'),
    )
  })
})
