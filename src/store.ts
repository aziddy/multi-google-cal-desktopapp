import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { preferenceStorage } from './data/preferences'
import { todayDate, DEFAULT_TIME_ZONE } from './domain/calendar'
import type { CalendarView, Theme } from './domain/types'

export const usePreferencePersistence = create<{ error: string | null }>(() => ({ error: null }))

function preferenceError(cause: unknown) {
  usePreferencePersistence.setState({
    error:
      cause instanceof Error
        ? cause.message
        : 'Preferences could not be saved. Check storage permissions and try again.',
  })
}

// Preferences can stay usable for this session when disk/browser storage is unavailable.
// Keep their error state separate from the persisted store to avoid recursive writes.
const reportedStorage: StateStorage = {
  getItem: async (name) => {
    try {
      return await preferenceStorage.getItem(name)
    } catch (cause) {
      preferenceError(cause)
      return null
    }
  },
  setItem: async (name, value) => {
    try {
      await preferenceStorage.setItem(name, value)
      usePreferencePersistence.setState({ error: null })
    } catch (cause) {
      preferenceError(cause)
    }
  },
  removeItem: async (name) => {
    try {
      await preferenceStorage.removeItem(name)
      usePreferencePersistence.setState({ error: null })
    } catch (cause) {
      preferenceError(cause)
    }
  },
}

function validZone(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

interface Preferences {
  date: string
  view: CalendarView
  theme: Theme
  timeZone: string
  hiddenCalendarIds: string[]
  sidebarOpen: boolean
  setDate: (date: string) => void
  setView: (view: CalendarView) => void
  setTheme: (theme: Theme) => void
  setTimeZone: (timeZone: string) => void
  toggleCalendar: (id: string) => void
  toggleSidebar: () => void
  reset: () => void
}

export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      date: todayDate(),
      view: 'week',
      theme: 'system',
      timeZone: DEFAULT_TIME_ZONE,
      hiddenCalendarIds: [],
      sidebarOpen: true,
      setDate: (date) => set({ date }),
      setView: (view) => set({ view }),
      setTheme: (theme) => set({ theme }),
      setTimeZone: (timeZone) => set({ timeZone }),
      toggleCalendar: (id) =>
        set((state) => ({
          hiddenCalendarIds: state.hiddenCalendarIds.includes(id)
            ? state.hiddenCalendarIds.filter((value) => value !== id)
            : [...state.hiddenCalendarIds, id],
        })),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      reset: () =>
        set((state) => ({ date: todayDate(state.timeZone), view: 'week', hiddenCalendarIds: [] })),
    }),
    {
      name: 'multi-calendar-preferences-v1',
      storage: createJSONStorage(() => reportedStorage),
      onRehydrateStorage: () => (_, error) => {
        if (error) preferenceError(error)
      },
      merge: (persisted, current) => {
        const saved =
          persisted && typeof persisted === 'object' ? (persisted as Partial<Preferences>) : {}
        const timeZone = validZone(saved.timeZone) ? saved.timeZone : current.timeZone
        return {
          ...current,
          date: todayDate(timeZone),
          timeZone,
          view: ['day', 'week', 'month', 'schedule'].includes(saved.view ?? '')
            ? saved.view!
            : current.view,
          theme: ['system', 'light', 'dark'].includes(saved.theme ?? '')
            ? saved.theme!
            : current.theme,
          sidebarOpen:
            typeof saved.sidebarOpen === 'boolean' ? saved.sidebarOpen : current.sidebarOpen,
          hiddenCalendarIds: Array.isArray(saved.hiddenCalendarIds)
            ? saved.hiddenCalendarIds.filter((id): id is string => typeof id === 'string')
            : [],
        }
      },
      partialize: (state) => ({
        view: state.view,
        theme: state.theme,
        timeZone: state.timeZone,
        hiddenCalendarIds: state.hiddenCalendarIds,
        sidebarOpen: state.sidebarOpen,
      }),
    },
  ),
)
