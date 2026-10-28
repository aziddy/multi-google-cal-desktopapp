import { useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { CalendarDays, Check, Monitor, Moon, RotateCcw, Sun, X } from 'lucide-react'
import type { Theme } from '../domain/types'
import './dialogs.css'
import { dataSource } from '../data/repository'
import { GoogleAccounts } from './GoogleAccounts'

interface SettingsDialogProps {
  theme: Theme
  timeZone: string
  onThemeChange: (theme: Theme) => void
  onTimeZoneChange: (zone: string) => void
  onReset: () => Promise<void>
  onClose: () => void
}

const zones = [
  'America/Chicago',
  'America/New_York',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
]

export function SettingsDialog({
  theme,
  timeZone,
  onThemeChange,
  onTimeZoneChange,
  onReset,
  onClose,
}: SettingsDialogProps) {
  const [confirmReset, setConfirmReset] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const returnFocus = useRef<HTMLElement | null>(null)

  async function reset() {
    if (pending) return
    setPending(true)
    setError('')
    try {
      await onReset()
      setConfirmReset(false)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to reset demo data. Please try again.',
      )
    } finally {
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
          className="calendar-dialog settings-dialog"
          onOpenAutoFocus={() => {
            returnFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            returnFocus.current?.focus({ preventScroll: true })
          }}
          onEscapeKeyDown={(e) => {
            if (pending) e.preventDefault()
          }}
          onInteractOutside={(e) => {
            if (pending) e.preventDefault()
          }}
        >
          <header className="settings-header">
            <div className="dialog-topline">
              <Dialog.Title className="settings-title">Settings</Dialog.Title>
              <Dialog.Close asChild>
                <button
                  className="dialog-icon-button"
                  aria-label="Close settings"
                  disabled={pending}
                >
                  <X size={20} />
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="settings-subtitle">
              A calendar that feels like yours.
            </Dialog.Description>
          </header>
          <div className="settings-body">
            <div
              className={
                dataSource === 'demo' ? 'settings-grid settings-grid-demo' : 'settings-grid'
              }
            >
              <div className="settings-general">
                <section className="settings-section">
                  <h3>Appearance</h3>
                  <div className="theme-options">
                    {(
                      [
                        { value: 'system', label: 'System', Icon: Monitor },
                        { value: 'light', label: 'Light', Icon: Sun },
                        { value: 'dark', label: 'Dark', Icon: Moon },
                      ] as const
                    ).map(({ value, label, Icon }) => (
                      <button
                        key={value}
                        className={`theme-option ${theme === value ? 'selected' : ''}`}
                        onClick={() => onThemeChange(value)}
                        aria-pressed={theme === value}
                      >
                        <Icon size={20} />
                        <span>{label}</span>
                        {theme === value && <Check size={12} className="theme-option-check" />}
                      </button>
                    ))}
                  </div>
                </section>
                <section className="settings-section">
                  <label className="settings-label" htmlFor="display-time-zone">
                    Display time zone
                  </label>
                  <select
                    id="display-time-zone"
                    className="settings-zone-select"
                    value={timeZone}
                    onChange={(e) => onTimeZoneChange(e.target.value)}
                  >
                    {[...new Set([timeZone, ...zones])].map((zone) => (
                      <option key={zone} value={zone}>
                        {zone.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                  <p className="settings-help">
                    Timed events adjust to this zone. All-day events keep their dates.
                  </p>
                </section>
              </div>
              {dataSource === 'google' && <GoogleAccounts />}
              {dataSource === 'demo' && (
                <div className="settings-demo-pane">
                  <section className="settings-demo-card">
                    <div className="settings-demo-icon">
                      <CalendarDays size={23} />
                    </div>
                    <div>
                      <h3>Your calendars, one place.</h3>
                      <p>
                        Browser preview uses sample accounts. Connect Google accounts in the desktop
                        app.
                      </p>
                      <span className="settings-demo-badge">LOCAL DEMO</span>
                    </div>
                  </section>
                  <section className="settings-section settings-reset-section">
                    <div>
                      <h3>Start fresh</h3>
                      <p className="settings-help">
                        Restore sample events around today. Your local edits will be replaced.
                      </p>
                    </div>
                    {confirmReset ? (
                      <div className="reset-confirmation">
                        <span>Replace your demo events?</span>
                        <div>
                          <button
                            className="dialog-text-button"
                            disabled={pending}
                            onClick={() => setConfirmReset(false)}
                          >
                            Cancel
                          </button>
                          <button
                            className="dialog-danger-button"
                            disabled={pending}
                            onClick={() => {
                              void reset()
                            }}
                          >
                            {pending ? 'Resetting…' : 'Reset demo'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="settings-reset-button"
                        onClick={() => setConfirmReset(true)}
                      >
                        <RotateCcw size={16} />
                        Reset demo data
                      </button>
                    )}
                  </section>
                </div>
              )}
            </div>
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="settings-about">
            <span>
              Multi Calendar <span className="settings-version">0.1.0</span>
            </span>
            <span>AGPL-3.0-only · Made for your desktop</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
