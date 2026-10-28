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
  RefreshCw,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { Temporal } from '@js-temporal/polyfill'
import { repository, dataSource } from './data/repository'
import { googleRepository } from './data/googleRepository'
import { useGoogleSync } from './data/useGoogleSync'
import {
  addDays,
  addMonths,
  canChangeEvent,
  formatDate,
  monthDays,
  todayDate,
  viewRange,
} from './domain/calendar'
import type {
  Account,
  Calendar,
  CalendarEvent,
  CalendarView,
  EventInput,
  MutationOptions,
  MutationScope,
} from './domain/types'
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
  { value: '7days', name: '7 days', key: 'X' },
]

const EMPTY_ACCOUNTS: Account[] = []
const EMPTY_CALENDARS: Calendar[] = []
const EMPTY_EVENTS: CalendarEvent[] = []

interface EditorState {
  event?: CalendarEvent
  date: string
  minute?: number
  allDay?: boolean
  scope?: MutationScope
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
    queryKey: [dataSource, 'accounts'],
    queryFn: () => repository.listAccounts(),
  })
  const calendarsQuery = useQuery({
    queryKey: [dataSource, 'calendars', accountsQuery.data?.map((account) => account.id)],
    queryFn: () => repository.listCalendars(),
  })
  const eventsQuery = useQuery({
    queryKey: [dataSource, 'events', accountsQuery.data?.map((account) => account.id)],
    queryFn: () => repository.listEvents(),
  })
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
  const range = viewRange(date, view, timeZone)
  const google = useGoogleSync(dataSource === 'google', calendars, hiddenCalendarIds, range)

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
      } else if (VIEWS.some((item) => item.key.toLowerCase() === key))
        setView(VIEWS.find((item) => item.key.toLowerCase() === key)!.value)
      else return
      if (key !== '/') event.preventDefault()
    }
    document.addEventListener('keydown', shortcuts)
    return () => document.removeEventListener('keydown', shortcuts)
  }, [date, timeZone, setDate, setView, editor, selected, settingsOpen, helpOpen])

  const saveMutation = useMutation({
    mutationFn: ({
      input,
      id,
      options,
    }: {
      input: EventInput
      id?: string
      options?: MutationOptions
    }) =>
      id ? repository.updateEvent(id, input, options) : repository.createEvent(input, options),
    onSuccess: async (_, variables) => {
      await client.invalidateQueries({ queryKey: [dataSource] })
      if (dataSource === 'google') await google.refresh().catch(() => undefined)
      setToast(variables.id ? 'Event updated' : 'Event created')
    },
    onError: (error) => setToast(error.message),
  })
  const deleteMutation = useMutation({
    mutationFn: ({ event, scope }: { event: CalendarEvent; scope: MutationScope }) =>
      repository.deleteEvent(event.id, { event, scope }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: [dataSource] })
      if (dataSource === 'google') await google.refresh().catch(() => undefined)
      setToast('Event deleted')
    },
  })

  async function saveEvent(input: EventInput, id?: string, options?: MutationOptions) {
    const current = options?.event ?? (id && events.find((event) => event.id === id))
    if (id && (!current || !canChangeEvent(current, 'edit')))
      throw new Error('This event is read-only. Reload it to see the latest permissions.')
    await saveMutation.mutateAsync({ input, id, options })
  }
  async function deleteEvent(event: CalendarEvent, scope: MutationScope = 'occurrence') {
    if (scope === 'series' && event.provider === 'google' && event.recurringEventId)
      event = await googleRepository.series(event.id)
    if (!canChangeEvent(event, 'delete')) throw new Error('This event is read-only.')
    await deleteMutation.mutateAsync({ event, scope })
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
        : addDays(
            date,
            direction * (view === 'week' || view === '7days' ? 7 : view === 'schedule' ? 30 : 1),
          ),
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
  const multiDay = view === 'week' || view === '7days'
  const rangeEnd = addDays(range.endDate, -1)
  const heading =
    view === 'day'
      ? formatDate(date, { month: 'long', day: 'numeric', year: 'numeric' })
      : multiDay && range.startDate.slice(0, 7) !== rangeEnd.slice(0, 7)
        ? `${formatDate(range.startDate, {
            month: 'short',
            ...(range.startDate.slice(0, 4) !== rangeEnd.slice(0, 4) && { year: 'numeric' }),
          })} – ${formatDate(rangeEnd, { month: 'short', year: 'numeric' })}`
        : formatDate(multiDay ? range.startDate : date, { month: 'long', year: 'numeric' })
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
                placeholder={
                  dataSource === 'google' ? 'Search downloaded events' : 'Search your calendars'
                }
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
            {dataSource === 'google' && (
              <button
                className="icon-button"
                aria-label="Refresh Google calendars"
                title="Refresh Google calendars"
                disabled={google.syncing}
                onClick={() =>
                  void google
                    .refresh()
                    .catch((error: unknown) =>
                      setToast(error instanceof Error ? error.message : 'Refresh failed'),
                    )
                }
              >
                <RefreshCw size={20} className={google.syncing ? 'spin' : ''} />
              </button>
            )}
            <button
              className="account-avatar"
              aria-label="Manage accounts and settings"
              title={
                accounts.length
                  ? `${accounts[0].name} · ${accounts.length} ${dataSource} accounts`
                  : 'Manage accounts'
              }
              onClick={() => setSettingsOpen(true)}
            >
              {accounts[0]?.initials.slice(0, 1) ?? '?'}
              <span />
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
          {dataSource === 'google' && accounts.length > 0 && (
            <div className="google-sync-banner" role="status">
              <span>
                {google.syncing
                  ? 'Syncing visible dates…'
                  : google.failures.length
                    ? `${google.failures.length} calendar(s) could not refresh. Cached events are shown.`
                    : google.missing.length
                      ? 'Some visible dates have not been downloaded completely.'
                      : 'Visible dates downloaded'}
                {searchOpen ? ' · Search covers downloaded dates only.' : ''}
              </span>
              {!!google.failures.length && <span>{google.failures[0].error}</span>}
            </div>
          )}
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
          ) : dataSource === 'google' && !accounts.length ? (
            <div className="empty-state">
              <CalendarDays size={40} />
              <h2>Connect your Google calendars</h2>
              <p>Import your Desktop OAuth client and connect an account to download calendars.</p>
              <button className="primary-button" onClick={() => setSettingsOpen(true)}>
                Connect Google account
              </button>
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
          scope={editor.scope}
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
          onEdit={async (scope = 'occurrence') => {
            const event = scope === 'series' ? await googleRepository.series(selected.id) : selected
            if (!canChangeEvent(event, 'edit'))
              throw new Error(event.capabilities?.reason ?? 'This series is read-only.')
            setEditor({
              event,
              scope,
              date: event.allDay
                ? event.start
                : Temporal.Instant.from(event.start)
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
                  {account.initials.slice(0, 1)}
                </span>
                <span>
                  <strong>{account.name}</strong>
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
          {dataSource === 'google' ? 'GOOGLE CALENDAR' : 'LOCAL PREVIEW'}
        </div>
        <p>
          {saving
            ? 'Saving your changes…'
            : preferenceError
              ? 'Preferences haven’t been saved'
              : dataSource === 'google'
                ? 'Cached viewing · online editing'
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
  onEdit: (scope?: MutationScope) => Promise<void>
  onDelete: (event: CalendarEvent, scope?: MutationScope) => Promise<void>
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [scope, setScope] = useState<MutationScope>('occurrence')
  const [seriesEvent, setSeriesEvent] = useState<CalendarEvent | null>(null)
  const actionEvent = scope === 'series' ? (seriesEvent ?? event) : event
  async function chooseScope(next: MutationScope) {
    setScope(next)
    setConfirmDelete(false)
    setError('')
    if (next !== 'series') return
    setPending(true)
    try {
      setSeriesEvent(await googleRepository.series(event.id))
    } catch (cause) {
      const reason =
        cause instanceof Error ? cause.message : 'The whole series could not be verified.'
      setError(reason)
      setSeriesEvent({ ...event, capabilities: { edit: false, delete: false, reason } })
    } finally {
      setPending(false)
    }
  }
  const recurring =
    event.provider === 'google' && (event.recurringEventId || event.recurrence?.length)
  async function edit() {
    setPending(true)
    setError('')
    try {
      await onEdit(scope)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load this series.')
      setPending(false)
    }
  }
  async function remove() {
    setPending(true)
    try {
      await onDelete(actionEvent, scope)
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
            {canChangeEvent(actionEvent, 'edit') && (
              <button
                className="icon-button"
                aria-label="Edit event"
                disabled={pending}
                onClick={() => void edit()}
              >
                <Pencil size={19} />
              </button>
            )}
            {canChangeEvent(actionEvent, 'delete') && (
              <button
                className="icon-button"
                aria-label="Delete event"
                disabled={pending}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={19} />
              </button>
            )}
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
          {recurring && (
            <label className="preview-row">
              Apply actions to
              <select
                aria-label="Recurring event scope"
                value={scope}
                onChange={(e) => void chooseScope(e.target.value as MutationScope)}
                disabled={pending}
              >
                <option value="occurrence">This occurrence</option>
                <option value="series">Whole series</option>
              </select>
            </label>
          )}
          {event.provider === 'google' && (
            <div className="preview-row">
              <button
                className="dialog-text-button"
                onClick={() =>
                  void googleRepository
                    .openEvent(event.id)
                    .catch((cause: unknown) =>
                      setError(
                        cause instanceof Error ? cause.message : 'Could not open Google Calendar.',
                      ),
                    )
                }
              >
                Open in Google Calendar
              </button>
            </div>
          )}
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
              <small>
                {event.provider === 'google' ? 'Google Calendar' : 'Demo calendar · saved locally'}
              </small>
            </span>
          </div>
          {error && (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          )}
          {confirmDelete && (
            <div className="delete-confirmation">
              <span>{scope === 'series' ? 'Delete the whole series?' : 'Delete this event?'}</span>
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
            {event.provider === 'google'
              ? (actionEvent.capabilities?.reason ?? 'Google Calendar')
              : 'Only on this device'}
            {canChangeEvent(actionEvent, 'edit') && (
              <button disabled={pending} onClick={() => void edit()}>
                Edit event
                <ChevronRight size={16} />
              </button>
            )}
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
          across your visible calendars{dataSource === 'google' ? ' over downloaded dates' : ''}.
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
              {dataSource === 'google'
                ? 'Connect your Google accounts in Settings. Downloaded events remain available offline. Meetings with guests and unsupported event types are read-only.'
                : 'This preview uses fictional accounts. Your edits stay on this device. Use the desktop app to connect Google accounts.'}
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
              ['Day / Week / Month / Schedule / 7 days', 'D W M A X'],
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
