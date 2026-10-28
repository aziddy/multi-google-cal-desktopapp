import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Temporal } from '@js-temporal/polyfill'
import { X } from 'lucide-react'
import './dialogs.css'

export function GoToDateDialog({
  date,
  onClose,
  onGo,
}: {
  date: string
  onClose: () => void
  onGo: (date: string) => void
}) {
  const [day, setDay] = useState(date)
  const [error, setError] = useState('')
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="calendar-dialog go-to-date-dialog">
          <div className="dialog-topline">
            <Dialog.Title className="settings-title">Go to date</Dialog.Title>
            <Dialog.Close className="dialog-icon-button" aria-label="Close date picker">
              <X size={20} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="settings-help">
            Choose a date to show in your current calendar view.
          </Dialog.Description>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              try {
                onGo(Temporal.PlainDate.from(day).toString())
              } catch {
                setError('Choose a valid date.')
              }
            }}
          >
            <label className="editor-field">
              <span>Date</span>
              <input
                type="date"
                required
                autoFocus
                value={day}
                onChange={(e) => {
                  setDay(e.target.value)
                  setError('')
                }}
              />
            </label>
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-footer-actions">
              <button type="button" className="dialog-text-button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="dialog-primary-button">
                Go
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
