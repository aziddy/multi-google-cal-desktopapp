import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import { CalendarDays, ChevronRight, Plus } from 'lucide-react'
import {
  addDays,
  eventsByDate,
  formatDate,
  monthDays,
  moveEvent,
  resizeEvent,
  canChangeEvent,
  timedSegments,
  todayDate,
  viewRange,
} from '../domain/calendar'
import type { Calendar, CalendarEvent, CalendarView, EventInput } from '../domain/types'
import { eventTime } from '../domain/display'
import {
  isSpanningEvent,
  layoutEventSpans,
  limitEventSpans,
  type EventSpan,
} from '../domain/eventSpans'

interface Props {
  view: CalendarView
  date: string
  events: CalendarEvent[]
  calendars: Calendar[]
  timeZone: string
  onCreate: (date: string, minute?: number, allDay?: boolean) => void
  onSelect: (event: CalendarEvent) => void
  onOpenDate: (date: string) => void
  onUpdate: (input: EventInput, id: string) => Promise<void>
}

interface ViewProps extends Props {
  dailyEvents: Map<string, CalendarEvent[]>
}

const HOUR_HEIGHT = 64
const MONTH_HEADER_HEIGHT = 34
const MONTH_EVENT_HEIGHT = 24
const weekday = (date: string, long = false) =>
  formatDate(date, { weekday: long ? 'long' : 'short' })
const dateNumber = (date: string) => Temporal.PlainDate.from(date).day

function colorFor(event: CalendarEvent, calendars: Calendar[]) {
  return (
    calendars.find(
      (calendar) => calendar.id === event.calendarId && calendar.accountId === event.accountId,
    )?.color ?? '#1a73e8'
  )
}

function spanClasses(span: EventSpan) {
  return `event-span ${span.continuesBefore ? 'continues-before' : ''} ${span.continuesAfter ? 'continues-after' : ''}`
}

function spanLabel(event: CalendarEvent, timeZone: string) {
  if (event.allDay) return event.title
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'full', timeStyle: 'short' }
  return `${event.title}, ${formatDate(event.start, options, timeZone)} to ${formatDate(event.end, options, timeZone)}`
}

function SpanContent({ event, timeZone }: { event: CalendarEvent; timeZone: string }) {
  return (
    <>
      {!event.allDay && <span className="span-event-time">{eventTime(event, timeZone)}</span>}
      <strong>{event.title}</strong>
      {!event.allDay && <span className="span-event-time">{eventTime(event, timeZone, true)}</span>}
    </>
  )
}

export function CalendarCanvas(props: Props) {
  const { date, view, timeZone, events } = props
  const dailyEvents = useMemo(
    () => eventsByDate(events, viewRange(date, view, timeZone)),
    [events, date, view, timeZone],
  )
  if (view === 'month') return <MonthView {...props} dailyEvents={dailyEvents} />
  if (view === 'schedule') return <ScheduleView {...props} dailyEvents={dailyEvents} />
  return <TimeView key={`${view}:${timeZone}`} {...props} dailyEvents={dailyEvents} />
}

function TimeView({
  view,
  date,
  dailyEvents,
  calendars,
  timeZone,
  onCreate,
  onSelect,
  onOpenDate,
  onUpdate,
}: ViewProps) {
  const { startDate } = viewRange(date, view, timeZone)
  const days = Array.from({ length: view === 'day' ? 1 : 7 }, (_, index) =>
    addDays(startDate, index),
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const suppressClick = useRef(false)
  const gestureCleanup = useRef<(() => void) | null>(null)
  const [ghost, setGhost] = useState<CalendarEvent | null>(null)
  const [now, setNow] = useState(() => Temporal.Now.zonedDateTimeISO(timeZone))
  const today = todayDate(timeZone)
  const zoneLabel = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date())
    .find((part) => part.type === 'timeZoneName')?.value

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = HOUR_HEIGHT * 7.6
    return () => gestureCleanup.current?.()
  }, [])

  useEffect(() => {
    const tick = () => setNow(Temporal.Now.zonedDateTimeISO(timeZone))
    const timer = window.setInterval(tick, 30_000)
    return () => window.clearInterval(timer)
  }, [timeZone])

  function beginGesture(
    pointer: ReactPointerEvent,
    event: CalendarEvent,
    mode: 'move' | 'resize',
    segmentDate: string,
  ) {
    if (pointer.button !== 0 || !canChangeEvent(event, 'edit')) return
    pointer.stopPropagation()
    gestureCleanup.current?.()
    const origin = { x: pointer.clientX, y: pointer.clientY }
    let dragged = false
    let latest: EventInput | undefined
    const original = Temporal.Instant.from(event.start).toZonedDateTimeISO(timeZone)
    const segmentOffset =
      original.toPlainDate().until(Temporal.PlainDate.from(segmentDate)).days * 1440
    const grabOffset =
      mode === 'move' && bodyRef.current
        ? segmentOffset +
          ((pointer.clientY - bodyRef.current.getBoundingClientRect().top) / HOUR_HEIGHT) * 60 -
          (original.hour * 60 + original.minute)
        : 0
    const move = (e: PointerEvent) => {
      if (!dragged && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < 5) return
      dragged = true
      suppressClick.current = true
      if (!bodyRef.current) return
      const bounds = bodyRef.current.getBoundingClientRect()
      const dayIndex = Math.max(
        0,
        Math.min(
          days.length - 1,
          Math.floor((e.clientX - bounds.left - 64) / ((bounds.width - 64) / days.length)),
        ),
      )
      const pointerMinute = Math.max(
        0,
        Math.min(1440, ((e.clientY - bounds.top) / HOUR_HEIGHT) * 60),
      )
      if (mode === 'move') {
        // The grab offset includes prior dates when dragging an overnight continuation.
        const target = Temporal.PlainDate.from(days[dayIndex])
          .toPlainDateTime('00:00')
          .add({ minutes: Math.round((pointerMinute - grabOffset) / 15) * 15 })
        latest = moveEvent(
          event,
          target.toPlainDate().toString(),
          target.hour * 60 + target.minute,
          timeZone,
        )
      } else {
        const minute = Math.max(
          original.hour * 60 + original.minute + 15,
          segmentOffset + Math.round(pointerMinute / 15) * 15,
        )
        latest = resizeEvent(event, minute, timeZone)
      }
      setGhost({ ...event, ...latest })
      const scroll = scrollRef.current
      if (scroll) {
        const edge = scroll.getBoundingClientRect()
        if (e.clientY > edge.bottom - 48) scroll.scrollTop += 10
        if (e.clientY < edge.top + 48) scroll.scrollTop -= 10
      }
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', escape)
      gestureCleanup.current = null
    }
    const cancel = () => {
      cleanup()
      setGhost(null)
      window.setTimeout(() => {
        suppressClick.current = false
      }, 0)
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
    }
    const end = () => {
      cleanup()
      setGhost(null)
      if (dragged && latest) {
        void onUpdate(latest, event.id).catch(() => undefined)
      }
      window.setTimeout(() => {
        suppressClick.current = false
      }, 0)
    }
    gestureCleanup.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', escape)
  }

  const stripEvents =
    view === 'day'
      ? new Map([[startDate, (dailyEvents.get(startDate) ?? []).filter((event) => event.allDay)]])
      : dailyEvents
  const spanningRows = layoutEventSpans(days, stripEvents, timeZone)
  const spanningRowCount = spanningRows.reduce((count, span) => Math.max(count, span.row + 1), 1)

  return (
    <section
      className="time-view"
      aria-label={`${view === 'day' ? 'Day' : view === '7days' ? '7 days' : 'Week'} calendar`}
    >
      <div className="time-header" style={{ '--day-count': days.length } as CSSProperties}>
        <div className="time-header-gutter" />
        {days.map((day) => (
          <button
            key={day}
            className={`day-heading ${day === today ? 'is-today' : ''}`}
            onClick={() => onOpenDate(day)}
            aria-label={`View ${formatDate(day, { dateStyle: 'full' })}`}
          >
            <span>{weekday(day)}</span>
            <strong>{dateNumber(day)}</strong>
          </button>
        ))}
      </div>
      <div
        className="all-day-grid"
        style={
          {
            '--day-count': days.length,
            '--all-day-rows': spanningRowCount,
          } as CSSProperties
        }
      >
        <div className="zone-label">{zoneLabel}</div>
        {days.map((day, index) => (
          <button
            className="all-day-cell"
            key={day}
            style={{ gridColumn: index + 2 }}
            aria-label={`Create all-day event on ${day}`}
            onClick={() => onCreate(day, 0, true)}
          />
        ))}
        {spanningRows.map((span) => (
          <button
            key={span.key}
            className={`all-day-event ${spanClasses(span)}`}
            data-event-id={span.event.id}
            style={{
              gridColumn: `${span.start + 2} / ${span.end + 2}`,
              top: span.row * 24 + 4,
              background: colorFor(span.event, calendars),
            }}
            onClick={() => onSelect(span.event)}
            title={spanLabel(span.event, timeZone)}
            aria-label={spanLabel(span.event, timeZone)}
          >
            <SpanContent event={span.event} timeZone={timeZone} />
          </button>
        ))}
      </div>
      <div className="time-scroll" ref={scrollRef}>
        <div
          className="time-body"
          ref={bodyRef}
          style={
            { '--day-count': days.length, '--hour-height': `${HOUR_HEIGHT}px` } as CSSProperties
          }
        >
          <div className="hours-column">
            {Array.from({ length: 23 }, (_, index) => index + 1).map((hour) => (
              <span key={hour} style={{ top: hour * HOUR_HEIGHT }}>
                {hour === 12 ? '12 PM' : hour > 12 ? `${hour - 12} PM` : `${hour} AM`}
              </span>
            ))}
          </div>
          {days.map((day) => (
            <div className={`time-day ${day === today ? 'is-today' : ''}`} key={day}>
              <div className="hour-hit-areas">
                {Array.from({ length: 24 }, (_, hour) => (
                  <button
                    tabIndex={-1}
                    key={hour}
                    aria-label={`Create event on ${day} at ${hour}:00`}
                    onClick={(e) => {
                      const offset = e.clientY - e.currentTarget.getBoundingClientRect().top
                      onCreate(
                        day,
                        hour * 60 + Math.min(45, Math.floor((offset / HOUR_HEIGHT) * 4) * 15),
                      )
                    }}
                  />
                ))}
              </div>
              {timedSegments(
                (dailyEvents.get(day) ?? []).filter(
                  (event) => view === 'day' || !isSpanningEvent(event),
                ),
                day,
                timeZone,
              ).map((segment) => {
                const { event, startMinute, endMinute, column, columns } = segment
                const height = Math.max(22, ((endMinute - startMinute) / 60) * HOUR_HEIGHT - 2)
                const original = Temporal.Instant.from(event.start).toZonedDateTimeISO(timeZone)
                const segmentOffset =
                  original.toPlainDate().until(Temporal.PlainDate.from(day)).days * 1440
                const isTerminal =
                  Temporal.Instant.from(event.end)
                    .subtract({ nanoseconds: 1 })
                    .toZonedDateTimeISO(timeZone)
                    .toPlainDate()
                    .toString() === day
                return (
                  <div
                    key={event.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${event.title}, ${eventTime(event, timeZone)} to ${eventTime(event, timeZone, true)}`}
                    data-event-id={event.id}
                    className={`timed-event ${ghost?.id === event.id ? 'is-dragging' : ''}`}
                    style={{
                      top: (startMinute / 60) * HOUR_HEIGHT + 1,
                      height,
                      left: `calc(${(column / columns) * 100}% + 3px)`,
                      width: `calc(${100 / columns}% - 7px)`,
                      background: colorFor(event, calendars),
                    }}
                    onPointerDown={(e) => beginGesture(e, event, 'move', day)}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (!suppressClick.current) onSelect(event)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelect(event)
                      }
                    }}
                  >
                    <strong>{event.title}</strong>
                    {height > 36 && (
                      <span>
                        {eventTime(event, timeZone)} – {eventTime(event, timeZone, true)}
                      </span>
                    )}
                    {height > 65 && event.location && (
                      <span className="event-location">{event.location}</span>
                    )}
                    {isTerminal && canChangeEvent(event, 'edit') && (
                      <span
                        role="slider"
                        tabIndex={0}
                        className="resize-handle"
                        aria-label={`Resize ${event.title}`}
                        aria-valuemin={original.hour * 60 + original.minute + 15}
                        aria-valuemax={segmentOffset + 1440}
                        aria-valuenow={segmentOffset + endMinute}
                        onPointerDown={(e) => beginGesture(e, event, 'resize', day)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                            e.preventDefault()
                            const input = resizeEvent(
                              event,
                              Math.max(
                                original.hour * 60 + original.minute + 15,
                                Math.min(
                                  segmentOffset + 1440,
                                  segmentOffset + endMinute + (e.key === 'ArrowDown' ? 15 : -15),
                                ),
                              ),
                              timeZone,
                            )
                            void onUpdate(input, event.id).catch(() => undefined)
                          }
                        }}
                      />
                    )}
                  </div>
                )
              })}
              {ghost &&
                timedSegments([ghost], day, timeZone).map((segment) => (
                  <div
                    key={ghost.id}
                    className="drag-ghost"
                    style={{
                      top: (segment.startMinute / 60) * HOUR_HEIGHT + 1,
                      height: Math.max(
                        22,
                        ((segment.endMinute - segment.startMinute) / 60) * HOUR_HEIGHT - 2,
                      ),
                      left: 3,
                      right: 5,
                      background: colorFor(ghost, calendars),
                    }}
                  >
                    <strong>{ghost.title}</strong>
                    <span>
                      {eventTime(ghost, timeZone)} – {eventTime(ghost, timeZone, true)}
                    </span>
                  </div>
                ))}
              {day === today && (
                <div
                  className="now-line"
                  style={{ top: ((now.hour * 60 + now.minute) / 60) * HOUR_HEIGHT }}
                >
                  <span />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function MonthView({
  date,
  dailyEvents,
  calendars,
  timeZone,
  onCreate,
  onSelect,
  onOpenDate,
}: ViewProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [capacity, setCapacity] = useState(3)
  useEffect(() => {
    if (!gridRef.current) return
    const observer = new ResizeObserver(([entry]) =>
      setCapacity(
        Math.max(
          1,
          Math.floor((entry.contentRect.height / 6 - MONTH_HEADER_HEIGHT) / MONTH_EVENT_HEIGHT),
        ),
      ),
    )
    observer.observe(gridRef.current)
    return () => observer.disconnect()
  }, [])
  const days = monthDays(date)
  const today = todayDate(timeZone)
  const month = Temporal.PlainDate.from(date).month
  return (
    <section className="month-view" aria-label="Month calendar">
      <div className="month-weekdays">
        {days.slice(0, 7).map((day) => (
          <span key={day}>{weekday(day)}</span>
        ))}
      </div>
      <div
        className="month-grid"
        ref={gridRef}
        style={
          {
            '--month-header-height': `${MONTH_HEADER_HEIGHT}px`,
            '--month-event-height': `${MONTH_EVENT_HEIGHT}px`,
          } as CSSProperties
        }
      >
        {Array.from({ length: 6 }, (_, week) => {
          const weekDays = days.slice(week * 7, week * 7 + 7)
          const { visible, hiddenCounts } = limitEventSpans(
            layoutEventSpans(weekDays, dailyEvents, timeZone, true),
            capacity,
            weekDays.length,
          )
          return (
            <div className="month-week" key={weekDays[0]}>
              {weekDays.map((day, column) => (
                <div
                  key={day}
                  data-date={day}
                  className={`month-day ${Temporal.PlainDate.from(day).month !== month ? 'outside-month' : ''}`}
                  onDoubleClick={(e) => {
                    if (e.target === e.currentTarget) onCreate(day, 540)
                  }}
                >
                  <button
                    className={`month-day-number ${day === today ? 'is-today' : ''}`}
                    onClick={() => onOpenDate(day)}
                    aria-label={`View ${formatDate(day, { dateStyle: 'full' })}`}
                  >
                    {dateNumber(day) === 1
                      ? formatDate(day, { month: 'short', day: 'numeric' })
                      : dateNumber(day)}
                  </button>
                  <button
                    className="month-create"
                    aria-label={`Create event on ${day}`}
                    onClick={() => onCreate(day, 540)}
                  >
                    <Plus size={14} />
                  </button>
                  {hiddenCounts[column] > 0 && (
                    <button
                      className="more-events"
                      style={{
                        top: MONTH_HEADER_HEIGHT + (capacity - 1) * MONTH_EVENT_HEIGHT + 1,
                      }}
                      onClick={() => onOpenDate(day)}
                    >
                      {hiddenCounts[column]} more
                    </button>
                  )}
                </div>
              ))}
              <div className="month-week-events">
                {visible.map((span) => (
                  <button
                    key={span.key}
                    data-event-id={span.event.id}
                    className={`month-event ${span.spanning ? `is-spanning ${spanClasses(span)}` : ''}`}
                    style={{
                      gridColumn: `${span.start + 1} / ${span.end + 1}`,
                      gridRow: span.row + 1,
                      ...(span.spanning && { background: colorFor(span.event, calendars) }),
                    }}
                    onClick={() => onSelect(span.event)}
                    title={span.spanning ? spanLabel(span.event, timeZone) : span.event.title}
                    aria-label={span.spanning ? spanLabel(span.event, timeZone) : undefined}
                  >
                    {span.spanning ? (
                      <SpanContent event={span.event} timeZone={timeZone} />
                    ) : (
                      <>
                        <i style={{ background: colorFor(span.event, calendars) }} />
                        <span className="month-event-time">{eventTime(span.event, timeZone)}</span>
                        <strong>{span.event.title}</strong>
                      </>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ScheduleView({
  date,
  dailyEvents,
  calendars,
  timeZone,
  onCreate,
  onSelect,
  onOpenDate,
}: ViewProps) {
  const today = todayDate(timeZone)
  const days = Array.from({ length: 30 }, (_, index) => addDays(date, index))
  const populated = days
    .map((day) => ({
      day,
      events: dailyEvents.get(day) ?? [],
    }))
    .filter((group) => group.events.length)
  return (
    <section className="schedule-view" aria-label="Schedule calendar">
      <div className="schedule-intro">
        <span>YOUR NEXT 30 DAYS</span>
        <span>{timeZone.replaceAll('_', ' ')}</span>
      </div>
      {!populated.length && (
        <div className="empty-state">
          <CalendarDays size={44} strokeWidth={1.4} />
          <h2>A little room to breathe</h2>
          <p>No events in the next 30 days.</p>
          <button className="primary-button" onClick={() => onCreate(date, 540)}>
            Create an event
          </button>
        </div>
      )}
      {populated.map(({ day, events: daily }) => (
        <div className={`schedule-day ${day === today ? 'is-today' : ''}`} key={day}>
          <button className="schedule-date" onClick={() => onOpenDate(day)}>
            <strong>{dateNumber(day)}</strong>
            <span>
              {formatDate(day, { month: 'short' })}
              <br />
              {weekday(day)}
            </span>
          </button>
          <div className="schedule-day-events">
            {daily.map((event) => (
              <button key={event.id} className="schedule-event" onClick={() => onSelect(event)}>
                <span className="schedule-time">
                  {event.allDay ? (
                    'All day'
                  ) : (
                    <>
                      {eventTime(event, timeZone)} <span>–</span> {eventTime(event, timeZone, true)}
                    </>
                  )}
                </span>
                <i style={{ background: colorFor(event, calendars) }} />
                <span className="schedule-summary">
                  <strong>{event.title}</strong>
                  <small>
                    {calendars.find((calendar) => calendar.id === event.calendarId)?.name}
                    {event.location && ` · ${event.location}`}
                  </small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        </div>
      ))}
      {populated.length > 0 && <div className="schedule-end">You’re all caught up.</div>}
    </section>
  )
}
