import { useId, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Temporal } from '@js-temporal/polyfill'
import { AlignLeft, CalendarDays, Clock3, MapPin, Trash2, X } from 'lucide-react'
import type {
  Calendar,
  CalendarEvent,
  EventInput,
  MutationOptions,
  MutationScope,
} from '../domain/types'
import { buildRecurrence, parseRecurrence } from '../domain/recurrence'
import { RecurrenceControls } from './RecurrenceControls'
import { dateTimeFields, resolveTimedEventRange } from './eventEditorTime'
import './dialogs.css'

interface EventEditorProps {
  event?: CalendarEvent
  initialDate: string
  initialMinute?: number
  initialAllDay?: boolean
  scope?: MutationScope
  calendars: Calendar[]
  timeZone: string
  onClose: () => void
  onSave: (input: EventInput, id?: string, options?: MutationOptions) => Promise<void>
  onDelete: (event: CalendarEvent, scope?: MutationScope) => Promise<void>
}

function initialFields(props: EventEditorProps) {
  const zone = props.event?.timeZone ?? props.timeZone
  if (props.event?.allDay) {
    return {
      startDate: props.event.start,
      endDate: Temporal.PlainDate.from(props.event.end).subtract({ days: 1 }).toString(),
      startTime: '09:00',
      endTime: '10:00',
    }
  }
  if (props.event) {
    const start = dateTimeFields(props.event.start, zone)
    const end = dateTimeFields(props.event.end, zone)
    return { startDate: start.date, endDate: end.date, startTime: start.time, endTime: end.time }
  }
  const minute = Math.max(0, Math.min(1425, props.initialMinute ?? 540))
  const start = Temporal.PlainDate.from(props.initialDate).toPlainDateTime({
    hour: Math.floor(minute / 60),
    minute: minute % 60,
  })
  const end = start.add({ hours: 1 })
  return {
    startDate: start.toPlainDate().toString(),
    endDate: end.toPlainDate().toString(),
    startTime: start.toPlainTime().toString({ smallestUnit: 'minute' }),
    endTime: end.toPlainTime().toString({ smallestUnit: 'minute' }),
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

export function EventEditor(props: EventEditorProps) {
  const { event, calendars, onClose, onSave, onDelete } = props
  const formId = useId()
  const [title, setTitle] = useState(event?.title ?? '')
  const [calendarId, setCalendarId] = useState(
    event?.calendarId ??
      calendars.find(
        (calendar) =>
          calendar.primary && (calendar.accessRole === 'writer' || calendar.accessRole === 'owner'),
      )?.id ??
      calendars.find(
        (calendar) =>
          !calendar.provider || calendar.accessRole === 'writer' || calendar.accessRole === 'owner',
      )?.id ??
      '',
  )
  const [allDay, setAllDay] = useState(event?.allDay ?? props.initialAllDay ?? false)
  const [fields, setFields] = useState(() => initialFields(props))
  const [timeZone, setTimeZone] = useState(event?.timeZone ?? props.timeZone)
  const [location, setLocation] = useState(event?.location ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [requestId] = useState(() => crypto.randomUUID())
  const [rule, setRule] = useState(() =>
    parseRecurrence(
      event?.recurrence,
      initialFields(props).startDate,
      event?.timeZone ?? props.timeZone,
    ),
  )
  const [ruleChanged, setRuleChanged] = useState(false)
  const scheduleLocked =
    event?.provider === 'google' &&
    (event.seriesScheduleEditable === false || (props.scope === 'series' && rule === null))
  const calendar = calendars.find((item) => item.id === calendarId)
  const setField = (field: keyof typeof fields, value: string) =>
    setFields((current) => ({ ...current, [field]: value }))

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (pending) return
    setError('')
    if (!title.trim()) {
      setError('Give your event a title.')
      return
    }
    if (!calendar) {
      setError('Choose a calendar for this event.')
      return
    }
    let input: EventInput
    try {
      Temporal.Now.zonedDateTimeISO(timeZone)
      let start: string
      let end: string
      if (allDay) {
        const startDate = Temporal.PlainDate.from(fields.startDate)
        const endDate = Temporal.PlainDate.from(fields.endDate)
        if (Temporal.PlainDate.compare(endDate, startDate) < 0)
          throw new Error('The end date must be on or after the start date.')
        start = startDate.toString()
        end = endDate.add({ days: 1 }).toString()
      } else {
        const range = resolveTimedEventRange(fields, timeZone, event)
        start = range.start
        end = range.end
      }
      input = {
        accountId: calendar.accountId,
        calendarId,
        title: title.trim(),
        start,
        end,
        allDay,
        timeZone,
        location:
          event && location === (event.location ?? '')
            ? event.location
            : location.trim() || undefined,
        description:
          event && description === (event.description ?? '')
            ? event.description
            : description.trim() || undefined,
        ...(calendar.provider === 'google' &&
        !event?.recurringEventId &&
        (ruleChanged || (event && fields.startDate !== initialFields(props).startDate)) &&
        rule
          ? { recurrence: buildRecurrence(rule, fields.startDate, allDay, timeZone) }
          : {}),
      }
    } catch (cause) {
      setError(
        cause instanceof RangeError
          ? 'Check the dates, times, and time zone for this event.'
          : errorMessage(cause),
      )
      return
    }
    setPending(true)
    try {
      await onSave(input, event?.id, { event, scope: props.scope ?? 'occurrence', requestId })
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
      setPending(false)
    }
  }

  async function remove() {
    if (!event || pending) return
    setPending(true)
    setError('')
    try {
      await onDelete(event, props.scope)
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
      setPending(false)
    }
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="calendar-dialog event-editor"
          onEscapeKeyDown={(e) => {
            if (pending) e.preventDefault()
          }}
          onInteractOutside={(e) => {
            if (pending) e.preventDefault()
          }}
        >
          <div className="dialog-topline">
            <span className="dialog-eyebrow">
              {event ? 'EVENT DETAILS' : 'MAKE TIME FOR SOMETHING'}
            </span>
            <Dialog.Close asChild>
              <button
                className="dialog-icon-button"
                aria-label="Close event editor"
                disabled={pending}
              >
                <X size={20} />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Title className="sr-only">{event ? 'Edit event' : 'Create event'}</Dialog.Title>
          <Dialog.Description className="sr-only">
            Save an event to a writable calendar.
          </Dialog.Description>
          <form
            id={formId}
            onSubmit={(e) => {
              void submit(e)
            }}
            className="event-form"
          >
            <fieldset disabled={pending} className="dialog-fields">
              <label className="sr-only" htmlFor={`${formId}-title`}>
                Event title
              </label>
              <input
                autoFocus
                id={`${formId}-title`}
                className="event-title-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Add title"
                maxLength={300}
                autoComplete="off"
              />
              <div className="event-type-pill">
                <span
                  className="event-type-dot"
                  style={{ background: calendar?.color ?? 'var(--primary)' }}
                />
                Event
              </div>
              {event?.provider === 'google' && (
                <p className="settings-help">
                  {props.scope === 'series'
                    ? 'Editing the whole series from its original anchor.'
                    : event.recurringEventId
                      ? 'Editing this occurrence only.'
                      : 'Editing a Google Calendar event.'}
                </p>
              )}
              {scheduleLocked && (
                <p className="settings-help">
                  {event?.seriesScheduleReason ??
                    'This schedule must be changed in Google Calendar.'}
                </p>
              )}
              <fieldset className="schedule-fields" disabled={scheduleLocked}>
                <div className="editor-row">
                  <Clock3 size={20} className="editor-row-icon" />
                  <div className="editor-row-content">
                    <div className="date-time-row">
                      <label className="editor-field">
                        <span>Start date</span>
                        <input
                          aria-label="Start date"
                          type="date"
                          required
                          value={fields.startDate}
                          onChange={(e) => setField('startDate', e.target.value)}
                        />
                      </label>
                      {!allDay && (
                        <label className="editor-field editor-time">
                          <span>Start time</span>
                          <input
                            aria-label="Start time"
                            type="time"
                            required
                            step={900}
                            value={fields.startTime}
                            onChange={(e) => setField('startTime', e.target.value)}
                          />
                        </label>
                      )}
                    </div>
                    <div className="date-time-row">
                      <label className="editor-field">
                        <span>End date{allDay ? ' (inclusive)' : ''}</span>
                        <input
                          aria-label="End date"
                          type="date"
                          required
                          min={fields.startDate}
                          value={fields.endDate}
                          onChange={(e) => setField('endDate', e.target.value)}
                        />
                      </label>
                      {!allDay && (
                        <label className="editor-field editor-time">
                          <span>End time</span>
                          <input
                            aria-label="End time"
                            type="time"
                            required
                            step={900}
                            value={fields.endTime}
                            onChange={(e) => setField('endTime', e.target.value)}
                          />
                        </label>
                      )}
                    </div>
                    <div className="all-day-row">
                      <label className="dialog-check">
                        <input
                          type="checkbox"
                          checked={allDay}
                          onChange={(e) => setAllDay(e.target.checked)}
                        />
                        <span>All day</span>
                      </label>
                      {!allDay && (
                        <label className="timezone-field">
                          <span className="sr-only">Event time zone</span>
                          <input
                            aria-label="Event time zone"
                            value={timeZone}
                            onChange={(e) => setTimeZone(e.target.value)}
                            placeholder="America/Chicago"
                            list={`${formId}-zones`}
                          />
                        </label>
                      )}
                    </div>
                    <datalist id={`${formId}-zones`}>
                      <option value="America/Chicago" />
                      <option value="America/New_York" />
                      <option value="America/Los_Angeles" />
                      <option value="Europe/London" />
                      <option value="Europe/Paris" />
                      <option value="Asia/Tokyo" />
                      <option value="UTC" />
                    </datalist>
                  </div>
                </div>
              </fieldset>
              {calendar?.provider === 'google' && !event?.recurringEventId && (
                <RecurrenceControls
                  rule={rule}
                  disabled={scheduleLocked}
                  onChange={(value) => {
                    setRule(value)
                    setRuleChanged(true)
                  }}
                />
              )}
              <div className="editor-row">
                <CalendarDays size={20} className="editor-row-icon" />
                <label className="editor-row-content editor-field">
                  <span>Calendar</span>
                  <span className="calendar-select-wrap">
                    <span className="calendar-select-dot" style={{ background: calendar?.color }} />
                    <select
                      disabled={event?.provider === 'google'}
                      aria-label="Calendar"
                      value={calendarId}
                      onChange={(e) => setCalendarId(e.target.value)}
                    >
                      {calendars
                        .filter(
                          (item) =>
                            !item.provider ||
                            item.accessRole === 'writer' ||
                            item.accessRole === 'owner',
                        )
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                            {item.accountEmail && item.name !== item.accountEmail
                              ? ` · ${item.accountEmail}`
                              : ''}
                          </option>
                        ))}
                    </select>
                  </span>
                </label>
              </div>
              <div className="editor-row">
                <MapPin size={20} className="editor-row-icon" />
                <label className="editor-row-content">
                  <span className="sr-only">Location</span>
                  <input
                    className="editor-line-input"
                    aria-label="Location"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="Add location"
                    maxLength={500}
                  />
                </label>
              </div>
              <div className="editor-row">
                <AlignLeft size={20} className="editor-row-icon" />
                <label className="editor-row-content">
                  <span className="sr-only">Description</span>
                  <textarea
                    className="editor-description"
                    aria-label="Description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Add description or notes"
                    rows={3}
                    maxLength={10000}
                  />
                </label>
              </div>
            </fieldset>
          </form>
          {error && (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          )}
          {confirmDelete && (
            <div className="delete-confirmation">
              <span>Delete this event?</span>
              <button
                type="button"
                className="dialog-text-button"
                disabled={pending}
                onClick={() => setConfirmDelete(false)}
              >
                Keep event
              </button>
              <button
                type="button"
                className="dialog-danger-button"
                disabled={pending}
                onClick={() => {
                  void remove()
                }}
              >
                {pending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          )}
          <div className="dialog-footer">
            <div>
              {event && !confirmDelete && (
                <button
                  type="button"
                  className="dialog-icon-button delete-event-button"
                  aria-label="Delete event"
                  disabled={pending}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={19} />
                </button>
              )}
            </div>
            <div className="dialog-footer-actions">
              <button
                type="button"
                className="dialog-text-button"
                disabled={pending}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="submit"
                form={formId}
                className="dialog-primary-button"
                disabled={pending || !calendars.length}
              >
                {pending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
