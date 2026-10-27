import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { isTauri } from '@tauri-apps/api/core'
import {
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Globe2,
  List,
  LoaderCircle,
  MapPin,
  Menu,
  Pencil,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { Temporal } from '@js-temporal/polyfill'
import { repository } from './data/repository'
import {
  addDays,
  addMonths,
  formatDate,
  monthDays,
  startOfWeek,
  todayDate,
} from './domain/calendar'
import type { Account, Calendar, CalendarEvent, CalendarView, EventInput } from './domain/types'
import { usePreferencePersistence, usePreferences } from './store'
import { CalendarCanvas } from './components/CalendarCanvas'
import { eventTime } from './domain/display'
import { EventEditor } from './components/EventEditor'
import { SettingsDialog } from './components/SettingsDialog'

const VIEWS: { value: CalendarView; name: string; key: string }[] = [
  { value: 'day', name: 'Day', key: 'D' },
  { value: 'week', name: 'Week', key: 'W' },
  { value: 'month', name: 'Month', key: 'M' },
  { value: 'schedule', name: 'Schedule', key: 'A' },
]

const EMPTY_ACCOUNTS: Account[] = []
const EMPTY_CALENDARS: Calendar[] = []
const EMPTY_EVENTS: CalendarEvent[] = []

interface EditorState {
  event?: CalendarEvent
  date: string
  minute?: number
  allDay?: boolean
}

function App() {
  const preferences = usePreferences()
  const preferenceSaveError = usePreferencePersistence((state) => state.error)
  const {
    date,
    view,
    theme,
    timeZone,
    hiddenCalendarIds,
    sidebarOpen,
    setDate,
    setView,
    setTheme,
    setTimeZone,
    toggleCalendar,
    toggleSidebar,
  } = preferences
  const client = useQueryClient()
  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: () => repository.listAccounts(),
  })
  const calendarsQuery = useQuery({
    queryKey: ['calendars'],
    queryFn: () => repository.listCalendars(),
  })
  const eventsQuery = useQuery({ queryKey: ['events'], queryFn: () => repository.listEvents() })
  const accounts = accountsQuery.data ?? EMPTY_ACCOUNTS
  const calendars = calendarsQuery.data ?? EMPTY_CALENDARS
  const events = eventsQuery.data ?? EMPTY_EVENTS
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [selected, setSelected] = useState<CalendarEvent | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [viewMenu, setViewMenu] = useState(false)
  const [toast, setToast] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const viewMenuRef = useRef<HTMLDivElement>(null)
  const today = todayDate(timeZone)

  useEffect(() => {
    document.documentElement.dataset.native = String(isTauri())
    document.documentElement.dataset.platform = /Macintosh|Mac OS X/.test(navigator.userAgent)
      ? 'mac'
      : 'other'
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (query.matches ? 'dark' : 'light') : theme
    }
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [theme])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 4200)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    if (!viewMenu) return
    const outside = (event: PointerEvent) => {
      if (!viewMenuRef.current?.contains(event.target as Node)) setViewMenu(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setViewMenu(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [viewMenu])

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')
      )
        return
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        editor ||
        selected ||
        settingsOpen ||
        helpOpen
      )
        return
      const key = event.key.toLowerCase()
      if (key === 't') setDate(todayDate(timeZone))
      else if (key === 'c') setEditor({ date, minute: 540 })
      else if (key === '/') {
        event.preventDefault()
        setSearchOpen(true)
        window.setTimeout(() => searchRef.current?.focus(), 0)
      } else if (['d', 'w', 'm', 'a'].includes(key))
        setView(VIEWS.find((item) => item.key.toLowerCase() === key)!.value)
      else return
      if (key !== '/') event.preventDefault()
    }
    document.addEventListener('keydown', shortcuts)
    return () => document.removeEventListener('keydown', shortcuts)
  }, [date, timeZone, setDate, setView, editor, selected, settingsOpen, helpOpen])

  const saveMutation = useMutation({
    mutationFn: ({ input, id }: { input: EventInput; id?: string }) =>
      id ? repository.updateEvent(id, input) : repository.createEvent(input),
    onSuccess: async (_, variables) => {
      await client.invalidateQueries({ queryKey: ['events'] })
      setToast(variables.id ? 'Event updated' : 'Event created')
    },
    onError: (error) => setToast(error.message),
  })
  const deleteMutation = useMutation({
    mutationFn: (event: CalendarEvent) => repository.deleteEvent(event.id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['events'] })
      setToast('Event deleted')
    },
  })

  async function saveEvent(input: EventInput, id?: string) {
    await saveMutation.mutateAsync({ input, id })
  }
  async function deleteEvent(event: CalendarEvent) {
    await deleteMutation.mutateAsync(event)
  }
  async function resetDemo() {
    await repository.resetDemo()
    preferences.reset()
    await client.invalidateQueries()
    setSelected(null)
    setSearch('')
    setToast('Demo calendars reset')
  }

  function navigate(direction: number) {
    setDate(
      view === 'month'
        ? addMonths(date, direction)
        : addDays(date, direction * (view === 'week' ? 7 : view === 'schedule' ? 30 : 1)),
    )
  }

  function openDate(day: string) {
    setDate(day)
    setView('day')
    setSearchOpen(false)
    setSearch('')
  }
  function createEvent(day = date, minute = 540, allDay = false) {
    setEditor({ date: day, minute, allDay })
  }
  const visibleEvents = events.filter((event) => !hiddenCalendarIds.includes(event.calendarId))
  const results = visibleEvents
    .filter((event) =>
      `${event.title} ${event.location ?? ''} ${event.description ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase().trim()),
    )
    .sort((a, b) => a.start.localeCompare(b.start))
  const rangeEnd = view === 'week' ? addDays(startOfWeek(date), 6) : date
  const heading =
    view === 'day'
      ? formatDate(date, { month: 'long', day: 'numeric', year: 'numeric' })
      : view === 'week' && startOfWeek(date).slice(0, 7) !== rangeEnd.slice(0, 7)
        ? `${formatDate(startOfWeek(date), { month: 'short' })} – ${formatDate(rangeEnd, { month: 'short', year: 'numeric' })}`
        : formatDate(view === 'week' ? startOfWeek(date) : date, { month: 'long', year: 'numeric' })
  const error = accountsQuery.error || calendarsQuery.error || eventsQuery.error
  const loading = accountsQuery.isPending || calendarsQuery.isPending || eventsQuery.isPending

  return (
    <div className="app-shell">
      <div className="native-drag-region" data-tauri-drag-region />
      <header className="app-header">
        <div className="brand-group">
          <button
            className="icon-button menu-button"
            aria-label="Toggle sidebar"
            title="Main menu"
            onClick={toggleSidebar}
          >
            <Menu size={23} />
          </button>
          <div className="calendar-logo" aria-hidden="true">
            <span>{Temporal.PlainDate.from(today).day}</span>
          </div>
          <span className="brand-name">Calendar</span>
        </div>
        <div className="header-main">
          {searchOpen ? (
            <div className="search-box">
              <Search size={21} />
              <input
                ref={searchRef}
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search your calendars"
                aria-label="Search events"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearchOpen(false)
                    setSearch('')
                  }
                }}
              />
              <button
                className="icon-button"
                aria-label="Close search"
                onClick={() => {
                  setSearchOpen(false)
                  setSearch('')
                }}
              >
                <X size={20} />
              </button>
            </div>
          ) : (
            <>
              <button
                className="today-button"
                onClick={() => setDate(today)}
                title={formatDate(today, { dateStyle: 'full' })}
              >
                Today
              </button>
              <div className="date-arrows">
                <button
                  className="icon-button"
                  aria-label="Previous period"
                  onClick={() => navigate(-1)}
                >
                  <ChevronLeft size={21} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Next period"
                  onClick={() => navigate(1)}
                >
                  <ChevronRight size={21} />
                </button>
              </div>
              <h1>{heading}</h1>
            </>
          )}
          <div className="header-actions">
            {!searchOpen && (
              <button
                className="icon-button"
                aria-label="Search events"
                title="Search (/)"
                onClick={() => {
                  setSearchOpen(true)
                  window.setTimeout(() => searchRef.current?.focus(), 0)
                }}
              >
                <Search size={23} />
              </button>
            )}
            <button
              className="icon-button help-button"
              aria-label="Help and keyboard shortcuts"
              title="Help"
              onClick={() => setHelpOpen(true)}
            >
              <CircleHelp size={22} />
            </button>
            <button
              className="icon-button"
              aria-label="Settings"
              title="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={23} />
            </button>
            <div className="view-dropdown" ref={viewMenuRef}>
              <button
                className="view-select"
                aria-label="Choose calendar view"
                aria-expanded={viewMenu}
                aria-haspopup="menu"
                onClick={() => setViewMenu(!viewMenu)}
              >
                {VIEWS.find((item) => item.value === view)?.name}
                <ChevronDown size={16} />
              </button>
              {viewMenu && (
                <div className="view-menu" role="menu" aria-label="Calendar views">
                  {VIEWS.map((item) => (
                    <button
                      role="menuitemradio"
                      aria-checked={view === item.value}
                      key={item.value}
                      onClick={() => {
                        setView(item.value)
                        setViewMenu(false)
                      }}
                    >
                      <span>{view === item.value && <Check size={16} />}</span>
                      {item.name}
                      <kbd>{item.key}</kbd>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="header-separator" />
            <button
              className="account-avatar"
              aria-label="Manage accounts and settings"
              title="Alex Morgan · 2 demo accounts"
              onClick={() => setSettingsOpen(true)}
            >
              A<span />
            </button>
          </div>
        </div>
      </header>
      <div className="workspace">
        {sidebarOpen && (
          <Sidebar
            accounts={accounts}
            calendars={calendars}
            date={date}
            today={today}
            hidden={hiddenCalendarIds}
            onToggle={toggleCalendar}
            onDate={setDate}
            onCreate={() => createEvent()}
            onSettings={() => setSettingsOpen(true)}
            saving={saveMutation.isPending || deleteMutation.isPending}
            preferenceError={preferenceSaveError}
          />
        )}
        <main className={`calendar-panel ${searchOpen ? 'search-panel' : ''}`}>
          {error ? (
            <div className="empty-state error-state">
              <CircleHelp size={40} />
              <h2>We couldn’t load your calendars</h2>
              <p>{error.message}</p>
              <div className="button-row">
                <button className="primary-button" onClick={() => void client.invalidateQueries()}>
                  Try again
                </button>
                <button className="secondary-button" onClick={() => setSettingsOpen(true)}>
                  Open settings
                </button>
              </div>
            </div>
          ) : loading ? (
            <div className="loading-state">
              <LoaderCircle size={28} className="spin" />
              <span>Getting your calendars ready…</span>
            </div>
          ) : searchOpen ? (
            <SearchResults
              events={results}
              query={search}
              calendars={calendars}
              timeZone={timeZone}
              onSelect={setSelected}
            />
          ) : (
            <CalendarCanvas
              view={view}
              date={date}
              events={visibleEvents}
              calendars={calendars}
              timeZone={timeZone}
              onCreate={createEvent}
              onSelect={setSelected}
              onOpenDate={openDate}
              onUpdate={saveEvent}
            />
          )}
        </main>
      </div>
      {editor && (
        <EventEditor
          event={editor.event}
          initialDate={editor.date}
          initialMinute={editor.minute}
          initialAllDay={editor.allDay}
          calendars={calendars}
          timeZone={timeZone}
          onClose={() => setEditor(null)}
          onSave={saveEvent}
          onDelete={deleteEvent}
        />
      )}
      {selected && (
        <EventPreview
          event={selected}
          calendar={calendars.find((calendar) => calendar.id === selected.calendarId)}
          timeZone={timeZone}
          onClose={() => setSelected(null)}
          onDelete={deleteEvent}
          onEdit={() => {
            setEditor({
              event: selected,
              date: selected.allDay
                ? selected.start
                : Temporal.Instant.from(selected.start)
                    .toZonedDateTimeISO(timeZone)
                    .toPlainDate()
                    .toString(),
            })
            setSelected(null)
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          theme={theme}
          timeZone={timeZone}
          onThemeChange={setTheme}
          onTimeZoneChange={setTimeZone}
          onReset={resetDemo}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          <span>{toast}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={16} />
          </button>
        </div>
      )}
      {preferenceSaveError && (
        <div className="persistence-alert" role="alert">
          <strong>Preferences haven’t been saved</strong>
          <p>{preferenceSaveError}</p>
          <button onClick={() => usePreferences.setState({})}>Retry saving</button>
        </div>
      )}
    </div>
  )
}

function Sidebar({
  accounts,
  calendars,
  date,
  today,
  hidden,
  onToggle,
  onDate,
  onCreate,
  onSettings,
  saving,
  preferenceError,
}: {
  accounts: Account[]
  calendars: Calendar[]
  date: string
  today: string
  hidden: string[]
  onToggle: (id: string) => void
  onDate: (date: string) => void
  onCreate: () => void
  onSettings: () => void
  saving: boolean
  preferenceError: string | null
}) {
  const [monthOverride, setMonthOverride] = useState<{ selected: string; month: string } | null>(
    null,
  )
  const miniMonth = monthOverride?.selected === date ? monthOverride.month : date
  const days = monthDays(miniMonth)
  const currentMonth = Temporal.PlainDate.from(miniMonth).month
  const [collapsed, setCollapsed] = useState<string[]>([])
  return (
    <aside className="sidebar" aria-label="Calendars sidebar">
      <button className="create-button" onClick={onCreate}>
        <Plus size={31} strokeWidth={1.7} />
        <span>Create</span>
        <ChevronDown size={15} />
      </button>
      <div className="sidebar-scroll">
        <div className="mini-calendar">
          <div className="mini-heading">
            <strong>{formatDate(miniMonth, { month: 'long', year: 'numeric' })}</strong>
            <div>
              <button
                className="icon-button"
                aria-label="Previous mini-calendar month"
                onClick={() =>
                  setMonthOverride({ selected: date, month: addMonths(miniMonth, -1) })
                }
              >
                <ChevronLeft size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="Next mini-calendar month"
                onClick={() => setMonthOverride({ selected: date, month: addMonths(miniMonth, 1) })}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
          <div className="mini-grid" role="grid" aria-label="Date picker">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
              <span className="mini-weekday" key={index} role="columnheader">
                {day}
              </span>
            ))}
            {days.map((day) => (
              <button
                role="gridcell"
                aria-selected={day === date}
                aria-label={formatDate(day, { dateStyle: 'full' })}
                key={day}
                className={`${day === today ? 'is-today' : ''} ${day === date ? 'is-selected' : ''} ${Temporal.PlainDate.from(day).month !== currentMonth ? 'is-outside' : ''}`}
                onClick={() => onDate(day)}
              >
                {Temporal.PlainDate.from(day).day}
              </button>
            ))}
          </div>
        </div>
        <button className="meet-with" onClick={onSettings}>
          <Users size={18} />
          <span>Your accounts</span>
          <span className="account-count">{accounts.length}</span>
        </button>
        <div className="account-calendars">
          {accounts.map((account) => (
            <section className="account-section" key={account.id}>
              <button
                className="account-heading"
                aria-expanded={!collapsed.includes(account.id)}
                onClick={() =>
                  setCollapsed((value) =>
                    value.includes(account.id)
                      ? value.filter((id) => id !== account.id)
                      : [...value, account.id],
                  )
                }
              >
                <span
                  className="sidebar-avatar"
                  style={{ background: `${account.color}18`, color: account.color }}
                >
                  {account.name.includes('Work') || account.email.includes('studio') ? 'W' : 'A'}
                </span>
                <span>
                  <strong>{account.email.includes('studio') ? 'Work' : 'Personal'}</strong>
                  <small>{account.email}</small>
                </span>
                <ChevronDown
                  size={16}
                  className={collapsed.includes(account.id) ? 'is-collapsed' : ''}
                />
              </button>
              {!collapsed.includes(account.id) && (
                <div className="calendar-checkboxes">
                  {calendars
                    .filter((calendar) => calendar.accountId === account.id)
                    .map((calendar) => (
                      <label
                        key={calendar.id}
                        className="calendar-checkbox"
                        style={{ '--calendar-color': calendar.color } as CSSProperties}
                      >
                        <input
                          type="checkbox"
                          checked={!hidden.includes(calendar.id)}
                          onChange={() => onToggle(calendar.id)}
                          aria-label={`Show ${calendar.name} calendar`}
                        />
                        <span className="checkbox-square">
                          <Check size={14} strokeWidth={3} />
                        </span>
                        <span>{calendar.name}</span>
                      </label>
                    ))}
                </div>
              )}
            </section>
          ))}
        </div>
        <button className="customize-button" onClick={onSettings}>
          <SlidersHorizontal size={17} />
          Customize your calendar
        </button>
      </div>
      <div className="sidebar-footer">
        <div className={`demo-label ${preferenceError ? 'has-error' : ''}`}>
          <span />
          LOCAL PREVIEW
        </div>
        <p>
          {saving
            ? 'Saving your changes…'
            : preferenceError
              ? 'Preferences haven’t been saved'
              : 'All changes saved on this device'}
        </p>
        <span className="footer-brand">
          Multi Calendar <span>v0.1</span>
        </span>
      </div>
    </aside>
  )
}

function EventPreview({
  event,
  calendar,
  timeZone,
  onClose,
  onEdit,
  onDelete,
}: {
  event: CalendarEvent
  calendar?: Calendar
  timeZone: string
  onClose: () => void
  onEdit: () => void
  onDelete: (event: CalendarEvent) => Promise<void>
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function remove() {
    setPending(true)
    try {
      await onDelete(event)
      onClose()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The event could not be deleted. Try again.',
      )
      setPending(false)
    }
  }
  const eventDate = event.allDay
    ? event.start
    : Temporal.Instant.from(event.start).toZonedDateTimeISO(timeZone).toPlainDate().toString()
  const endDate = event.allDay
    ? addDays(event.end, -1)
    : Temporal.Instant.from(event.end).toZonedDateTimeISO(timeZone).toPlainDate().toString()
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="preview-overlay" />
        <Dialog.Content
          className="event-preview"
          aria-describedby="preview-description"
          onEscapeKeyDown={(e) => {
            if (pending) e.preventDefault()
          }}
          onInteractOutside={(e) => {
            if (pending) e.preventDefault()
          }}
        >
          <div className="preview-toolbar">
            <button
              className="icon-button"
              aria-label="Edit event"
              disabled={pending}
              onClick={onEdit}
            >
              <Pencil size={19} />
            </button>
            <button
              className="icon-button"
              aria-label="Delete event"
              disabled={pending}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={19} />
            </button>
            <Dialog.Close
              className="icon-button"
              aria-label="Close event details"
              disabled={pending}
            >
              <X size={21} />
            </Dialog.Close>
          </div>
          <div className="preview-heading">
            <span style={{ background: calendar?.color ?? '#1a73e8' }} />
            <Dialog.Title>{event.title}</Dialog.Title>
          </div>
          <Dialog.Description id="preview-description" className="preview-date">
            {formatDate(eventDate, { weekday: 'long', month: 'long', day: 'numeric' })}
            {endDate !== eventDate &&
              ` – ${formatDate(endDate, { month: 'long', day: 'numeric' })}`}
          </Dialog.Description>
          <div className="preview-row">
            <Clock3 size={19} />
            <span>
              {event.allDay
                ? 'All day'
                : `${eventTime(event, timeZone)} – ${eventTime(event, timeZone, true)}`}
              <small>{timeZone.replaceAll('_', ' ')}</small>
            </span>
          </div>
          {event.location && (
            <div className="preview-row">
              <MapPin size={19} />
              <span>{event.location}</span>
            </div>
          )}
          {event.description && (
            <div className="preview-row">
              <List size={19} />
              <p>{event.description}</p>
            </div>
          )}
          <div className="preview-row">
            <CalendarDays size={19} />
            <span>
              {calendar?.name ?? 'Calendar'}
              <small>Demo calendar · saved locally</small>
            </span>
          </div>
          {error && (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          )}
          {confirmDelete && (
            <div className="delete-confirmation">
              <span>Delete this event?</span>
              <button
                className="dialog-text-button"
                disabled={pending}
                onClick={() => setConfirmDelete(false)}
              >
                Keep event
              </button>
              <button
                className="dialog-danger-button"
                disabled={pending}
                onClick={() => void remove()}
              >
                {pending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          )}
          <div className="preview-footer">
            <span className="local-dot" />
            Only on this device
            <button disabled={pending} onClick={onEdit}>
              Edit event
              <ChevronRight size={16} />
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SearchResults({
  events,
  query,
  calendars,
  timeZone,
  onSelect,
}: {
  events: CalendarEvent[]
  query: string
  calendars: Calendar[]
  timeZone: string
  onSelect: (event: CalendarEvent) => void
}) {
  if (!query.trim())
    return (
      <div className="empty-state">
        <Search size={42} strokeWidth={1.4} />
        <h2>Find a moment</h2>
        <p>
          Search event titles, places, and descriptions
          <br />
          across your visible calendars.
        </p>
      </div>
    )
  return (
    <section className="search-results" aria-label="Search results">
      <div className="search-results-heading">
        <h2>Search results</h2>
        <span>
          {events.length} {events.length === 1 ? 'event' : 'events'} for “{query}”
        </span>
      </div>
      {!events.length ? (
        <div className="empty-state">
          <Search size={38} strokeWidth={1.4} />
          <h2>No matching events</h2>
          <p>Try a different search or show more calendars.</p>
        </div>
      ) : (
        events.map((event) => {
          const calendar = calendars.find((item) => item.id === event.calendarId)
          const eventDate = event.allDay
            ? event.start
            : Temporal.Instant.from(event.start)
                .toZonedDateTimeISO(timeZone)
                .toPlainDate()
                .toString()
          return (
            <button key={event.id} className="search-result" onClick={() => onSelect(event)}>
              <span className="search-result-date">
                {formatDate(eventDate, { month: 'short', day: 'numeric' })}
                <small>{formatDate(eventDate, { weekday: 'short', year: 'numeric' })}</small>
              </span>
              <i style={{ background: calendar?.color }} />
              <span>
                <strong>{event.title}</strong>
                <small>
                  {eventTime(event, timeZone)} · {calendar?.name}
                  {event.location && ` · ${event.location}`}
                </small>
              </span>
              <ChevronRight size={17} />
            </button>
          )
        })
      )}
    </section>
  )
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="help-dialog" aria-describedby="help-description">
          <Dialog.Close className="icon-button help-close" aria-label="Close help">
            <X size={20} />
          </Dialog.Close>
          <div className="help-icon">
            <CalendarDays size={27} />
          </div>
          <Dialog.Title>Your calendars, one place.</Dialog.Title>
          <Dialog.Description id="help-description">
            A familiar calendar with a little more room for all your accounts.
          </Dialog.Description>
          <div className="help-note">
            <Globe2 size={20} />
            <p>
              This preview uses fictional accounts. Your edits stay on this device. Google account
              connection is planned for the next milestone.
            </p>
          </div>
          <h3>Make yourself at home</h3>
          <p className="help-instructions">
            Click an empty time slot to create an event. Drag events to move them, or drag their
            bottom edge to resize.
          </p>
          <div className="shortcut-list">
            {[
              ['Create event', 'C'],
              ['Today', 'T'],
              ['Search', '/'],
              ['Day / Week / Month / Schedule', 'D W M A'],
            ].map(([label, key]) => (
              <div key={key}>
                <span>{label}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
          <span className="help-license">AGPL-3.0-only · Multi Calendar 0.1.0</span>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export default App
