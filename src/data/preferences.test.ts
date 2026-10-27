import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPreferenceStorage } from './preferences'

const platform = vi.hoisted(() => ({ native: false, load: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => platform.native }))
vi.mock('@tauri-apps/plugin-store', () => ({ load: platform.load }))

beforeEach(() => {
  platform.native = false
  platform.load.mockReset()
  localStorage.clear()
})

describe('preference storage', () => {
  it('roundtrips and removes preferences in browser localStorage', async () => {
    const storage = createPreferenceStorage()
    const value = JSON.stringify({ state: { view: 'month', theme: 'dark' } })
    expect(await storage.getItem('preferences')).toBeNull()
    await storage.setItem('preferences', value)
    expect(localStorage.getItem('preferences')).toBe(value)
    expect(await storage.getItem('preferences')).toBe(value)
    await storage.removeItem('preferences')
    expect(await storage.getItem('preferences')).toBeNull()
  })

  it('uses one native store and persists serialized sets and removal', async () => {
    platform.native = true
    const values = new Map<string, string>()
    const persisted: (string | undefined)[] = []
    const native = {
      get: vi.fn(async (name: string) => values.get(name)),
      set: vi.fn(async (name: string, value: string) => {
        values.set(name, value)
      }),
      delete: vi.fn(async (name: string) => values.delete(name)),
      save: vi.fn(async () => {
        await Promise.resolve()
        persisted.push(values.get('preferences'))
      }),
    }
    platform.load.mockResolvedValue(native)
    const storage = createPreferenceStorage()
    await Promise.all([
      storage.setItem('preferences', 'first'),
      storage.setItem('preferences', 'second'),
      storage.removeItem('preferences'),
    ])
    expect(persisted).toEqual(['first', 'second', undefined])
    expect(await storage.getItem('preferences')).toBeNull()
    expect(platform.load).toHaveBeenCalledExactlyOnceWith('preferences.json', {
      defaults: {},
      autoSave: false,
    })
    expect(localStorage.length).toBe(0)
  })

  it('rolls native cache back after a failed save and permits retry', async () => {
    platform.native = true
    let value: string | undefined = 'saved'
    const native = {
      get: vi.fn(async () => value),
      set: vi.fn(async (_name: string, next: string) => {
        value = next
      }),
      delete: vi.fn(async () => {
        value = undefined
      }),
      save: vi.fn(async () => undefined).mockRejectedValueOnce(new Error('Disk full')),
    }
    platform.load.mockResolvedValue(native)
    const storage = createPreferenceStorage()
    await expect(storage.setItem('preferences', 'new')).rejects.toThrow(
      'Your preferences could not be saved',
    )
    expect(await storage.getItem('preferences')).toBe('saved')
    await storage.setItem('preferences', 'retry')
    expect(await storage.getItem('preferences')).toBe('retry')
  })
})
