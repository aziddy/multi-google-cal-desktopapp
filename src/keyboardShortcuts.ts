import type { CalendarView } from './domain/types'

export const CALENDAR_VIEWS: {
  value: CalendarView
  name: string
  key: string
  number: string
}[] = [
  { value: 'day', name: 'Day', key: 'D', number: '1' },
  { value: 'week', name: 'Week', key: 'W', number: '2' },
  { value: 'month', name: 'Month', key: 'M', number: '3' },
  { value: 'schedule', name: 'Schedule', key: 'A', number: '5' },
  { value: '7days', name: '7 days', key: 'X', number: '4' },
]

type ShortcutAction =
  | CalendarView
  | 'previous'
  | 'next'
  | 'today'
  | 'goToDate'
  | 'create'
  | 'createAllDay'
  | 'edit'
  | 'delete'
  | 'save'
  | 'search'
  | 'settings'
  | 'help'
  | 'escape'

export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]',
    ) !== null
  )
}

export function shortcutAction(event: KeyboardEvent): ShortcutAction | null {
  if (event.defaultPrevented || event.isComposing || event.altKey) return null
  const key = event.key.toLowerCase()
  if (event.metaKey || event.ctrlKey) {
    if (event.shiftKey || (event.metaKey && event.ctrlKey)) return null
    if (key === 's' || key === 'enter') return 'save'
    if (key === '/') return 'help'
    return null
  }
  if (key === '?') return 'help'
  if (event.shiftKey) return key === 'c' ? 'create' : null
  const view = CALENDAR_VIEWS.find((view) => view.key.toLowerCase() === key || view.number === key)
  if (view) return view.value
  switch (key) {
    case 'p':
    case 'k':
      return 'previous'
    case 'n':
    case 'j':
      return 'next'
    case 't':
      return 'today'
    case 'g':
      return 'goToDate'
    case 'c':
      return 'create'
    case 'q':
      return 'createAllDay'
    case 'e':
      return 'edit'
    case 'backspace':
    case 'delete':
      return 'delete'
    case '/':
      return 'search'
    case 's':
      return 'settings'
    case 'escape':
      return 'escape'
    default:
      return null
  }
}
