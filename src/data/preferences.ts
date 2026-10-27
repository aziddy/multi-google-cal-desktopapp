import { isTauri } from '@tauri-apps/api/core'
import type { StateStorage } from 'zustand/middleware'
import type { Store } from '@tauri-apps/plugin-store'

/** Zustand's JSON strings stay identical across the desktop and browser adapters. */
export function createPreferenceStorage(): StateStorage<Promise<void>> {
  let storePromise: Promise<Store> | undefined
  let queue: Promise<unknown> = Promise.resolve()

  const store = () => {
    if (!storePromise) {
      storePromise = import('@tauri-apps/plugin-store').then(({ load }) =>
        load('preferences.json', { defaults: {}, autoSave: false }),
      )
      storePromise.catch(() => {
        storePromise = undefined
      })
    }
    return storePromise
  }

  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation)
    queue = result.catch(() => undefined)
    return result
  }

  const writeNative = async (name: string, value: string | null) => {
    const current = await store()
    const previous = await current.get<string>(name)
    try {
      if (value === null) await current.delete(name)
      else await current.set(name, value)
      await current.save()
    } catch (cause) {
      // The plugin also saves on app exit, so restore its cache after failed writes.
      if (previous === undefined) await current.delete(name)
      else await current.set(name, previous)
      throw new Error(
        'Your preferences could not be saved. Check available disk space and storage permissions, then try again.',
        { cause },
      )
    }
  }

  return {
    getItem: (name) =>
      serial(async () => {
        if (!isTauri()) return localStorage.getItem(name)
        const value = await (await store()).get<unknown>(name)
        return typeof value === 'string' ? value : null
      }),
    setItem: (name, value) =>
      serial(async () => {
        if (!isTauri()) localStorage.setItem(name, value)
        else await writeNative(name, value)
      }),
    removeItem: (name) =>
      serial(async () => {
        if (!isTauri()) localStorage.removeItem(name)
        else await writeNative(name, null)
      }),
  }
}

export const preferenceStorage = createPreferenceStorage()
