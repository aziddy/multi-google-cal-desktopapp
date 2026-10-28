import { expect, test, type Page } from '@playwright/test'
import type { CredentialStorage, GoogleSnapshot } from '../src/data/googleRepository'
import type { CalendarEvent } from '../src/domain/types'

const account = {
  id: 'google:a',
  name: 'Demo User',
  email: 'demo@example.test',
  initials: 'DU',
  color: '#1a73e8',
  provider: 'google' as const,
  connectionStatus: 'connected',
}
const calendar = {
  id: 'google:a:cal',
  accountId: account.id,
  name: 'Real calendar',
  color: '#0b8043',
  provider: 'google' as const,
  timeZone: 'America/Chicago',
  accessRole: 'owner' as const,
}
const event: CalendarEvent = {
  id: 'google:a:cal:one',
  accountId: account.id,
  calendarId: calendar.id,
  title: 'Downloaded appointment',
  start: '2026-10-26T14:00:00Z',
  end: '2026-10-26T15:00:00Z',
  allDay: false,
  timeZone: 'America/Chicago',
  provider: 'google',
  location: 'Old place',
  description: '  preserve <b>this</b>  ',
  etag: '"v1"',
  capabilities: { edit: true, delete: true },
}

async function nativePreview(
  page: Page,
  events: CalendarEvent[] = [event],
  connected = true,
  credentialBlocked = false,
  options: { storage?: CredentialStorage; connecting?: boolean } = {},
) {
  const snapshot: GoogleSnapshot = {
    credentialStorage: options.storage ?? (credentialBlocked ? 'os_store' : 'local_file'),
    client: connected
      ? { clientId: 'test.apps.googleusercontent.com', projectId: 'test-project' }
      : null,
    accounts: connected
      ? [
          {
            ...account,
            connectionStatus: credentialBlocked ? 'credential_access_required' : 'connected',
          },
        ]
      : [],
    calendars: connected ? [calendar] : [],
    events: connected ? events : [],
    syncStatus: connected
      ? [
          {
            accountId: account.id,
            calendarId: calendar.id,
            lastSuccess: null,
            error: 'Offline: cached events are shown.',
            retryAt: 0,
            coverage: [],
          },
        ]
      : [],
    connecting: options.connecting ?? false,
    pendingMutations: 0,
  }
  await page.addInitScript(
    ({ initial, account, calendar, events }) => {
      const snapshot = initial
      const storageKey = '__test_google_credential_storage'
      const savedStorage = sessionStorage.getItem(storageKey)
      if (savedStorage === 'local_file' || savedStorage === 'os_store')
        snapshot.credentialStorage = savedStorage
      let preferences = JSON.stringify({
        version: 0,
        state: {
          date: '2026-10-26',
          view: 'week',
          timeZone: 'America/Chicago',
          theme: 'light',
          hiddenCalendarIds: [],
          sidebarOpen: true,
        },
      })
      const calls: { command: string; args: Record<string, unknown> }[] = []
      Object.assign(window, {
        isTauri: true,
        __googleCalls: calls,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: Record<string, unknown> = {}) => {
            calls.push({ command, args })
            if (command === 'plugin:store|load') return 1
            if (command === 'plugin:store|get') return [preferences, true]
            if (command === 'plugin:store|set') {
              preferences = String(args.value)
              return null
            }
            if (command.startsWith('plugin:')) return null
            if (command === 'google_set_credential_storage') {
              const control = window as unknown as {
                __failStorageChange?: boolean
                __holdStorageChange?: boolean
                __finishStorageChange?: () => void
              }
              if (control.__failStorageChange)
                throw {
                  code: 'CREDENTIAL_SETTINGS',
                  message: 'Credential storage settings could not be saved.',
                }
              if (control.__holdStorageChange)
                await new Promise<void>((resolve) => {
                  control.__finishStorageChange = resolve
                })
              snapshot.credentialStorage = args.storage as CredentialStorage
              sessionStorage.setItem(storageKey, snapshot.credentialStorage)
              snapshot.accounts.forEach((account) => {
                account.connectionStatus =
                  snapshot.credentialStorage === 'local_file' ? 'connected' : 'reconnect_required'
              })
            }
            if (command === 'google_import_client')
              snapshot.client = {
                clientId: 'test.apps.googleusercontent.com',
                projectId: 'test-project',
              }
            if (command === 'google_connect') {
              snapshot.accounts = [account]
              snapshot.calendars = [calendar]
              snapshot.events = events
            }
            if (command === 'google_retry_credentials')
              snapshot.accounts.forEach((account) => {
                account.connectionStatus = 'connected'
              })
            if (command === 'google_disconnect') {
              snapshot.accounts = []
              snapshot.calendars = []
              snapshot.events = []
            }
            if (command === 'google_series')
              return {
                ...events[0],
                id: 'google:a:cal:parent',
                recurringEventId: undefined,
                start: '2024-01-31T15:00:00Z',
                end: '2024-01-31T16:00:00Z',
                recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=31'],
                seriesScheduleEditable: false,
                seriesScheduleReason: 'This series has exceptions.',
              }
            if (command === 'google_mutate') {
              const mutation = args.mutation as {
                operation: string
                eventId: string
                changes: Record<string, unknown>
              }
              if (mutation.operation === 'delete') {
                snapshot.events = snapshot.events.filter((event) => event.id !== mutation.eventId)
                return null
              }
              const event = snapshot.events.find((event) => event.id === mutation.eventId)!
              if (mutation.changes.title) event.title = String(mutation.changes.title)
              if (mutation.changes.location === null) delete event.location
              return structuredClone(event)
            }
            return structuredClone(snapshot)
          },
        },
      })
    },
    { initial: snapshot, account, calendar, events },
  )
  await page.goto('/')
}

test('native settings import a client, connect a real account, and disconnect local data', async ({
  page,
}) => {
  await nativePreview(page, [event], false)
  await page.getByRole('button', { name: 'Connect Google account', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.getByRole('button', { name: 'Use saved client' }).click()
  await expect(dialog.getByText('OAuth project: test-project')).toBeVisible()
  await dialog.getByRole('button', { name: 'Connect another Google account' }).click()
  await expect(dialog.getByText('demo@example.test', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Import OAuth JSON' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await dialog.getByRole('button', { name: 'Remove local account' }).click()
  await expect(dialog.getByText('demo@example.test', { exact: true })).toHaveCount(0)
})
test('guest-bearing Google events expose read-only details and downloaded coverage', async ({
  page,
}) => {
  await nativePreview(page, [
    {
      ...event,
      capabilities: { edit: false, delete: false, reason: 'Meetings with guests are read-only.' },
    },
  ])
  await expect(page.getByText('Offline: cached events are shown.')).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Resize Downloaded appointment' })).toHaveCount(0)
  await page.locator('[data-event-id="google:a:cal:one"]').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Edit event', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Delete event', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Open in Google Calendar' })).toBeVisible()
})
test('Google edits send explicit clearing, preserve untouched descriptions, and lock calendar moves', async ({
  page,
}) => {
  await nativePreview(page)
  await page.locator('[data-event-id="google:a:cal:one"]').click()
  await page.getByRole('button', { name: 'Edit event', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Edit event', exact: true })
  await expect(dialog.getByLabel('Calendar', { exact: true })).toBeDisabled()
  await dialog.getByRole('textbox', { name: 'Event title' }).fill('Updated title')
  await dialog.getByRole('textbox', { name: 'Location', exact: true }).fill('')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const mutation = await page.evaluate(
    () =>
      (
        window as unknown as { __googleCalls: { command: string; args: { mutation: unknown } }[] }
      ).__googleCalls.find((call) => call.command === 'google_mutate')?.args.mutation,
  )
  expect(mutation).toMatchObject({
    expectedEtag: '"v1"',
    scope: 'occurrence',
    changes: { title: 'Updated title', location: null },
  })
  expect((mutation as { changes: Record<string, unknown> }).changes).not.toHaveProperty(
    'description',
  )
})
test('whole-series editor loads the original anchor and locks schedules with exceptions', async ({
  page,
}) => {
  await nativePreview(page, [
    { ...event, recurringEventId: 'google:a:cal:parent', originalStart: event.start },
  ])
  await page.locator('[data-event-id="google:a:cal:one"]').click()
  await page.getByLabel('Recurring event scope').selectOption('series')
  await page.getByRole('button', { name: 'Edit event', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Edit event', exact: true })
  await expect(dialog.getByLabel('Start date', { exact: true })).toHaveValue('2024-01-31')
  await expect(dialog.getByLabel('Start date', { exact: true })).toBeDisabled()
  await expect(dialog.getByLabel('Repeats', { exact: true })).toBeDisabled()
  await expect(dialog.getByRole('textbox', { name: 'Event title' })).toBeEnabled()
})

test('locked credentials require an explicit Settings retry', async ({ page }) => {
  await nativePreview(page, [event], true, true)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(dialog.getByText('Credential access required', { exact: true })).toBeVisible()
  const attempts = () =>
    page.evaluate(
      () =>
        (window as unknown as { __googleCalls: { command: string }[] }).__googleCalls.filter(
          (call) => call.command === 'google_retry_credentials',
        ).length,
    )
  expect(await attempts()).toBe(0)
  await dialog.getByRole('button', { name: 'Retry credential access' }).click()
  await expect(dialog.getByText('Connected', { exact: true })).toBeVisible()
  expect(await attempts()).toBe(1)
})

test('credential storage defaults to local files and switches immediately without losing cached events', async ({
  page,
}) => {
  await nativePreview(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  const storage = () => dialog.getByRole('combobox', { name: 'Credential storage' })
  await expect(storage()).toHaveValue('local_file')
  await expect(dialog.getByText(/saved unencrypted in a local file/)).toBeVisible()
  await storage().selectOption('os_store')
  await expect(storage()).toHaveValue('os_store')
  await expect(dialog.getByText('Reconnect required', { exact: true })).toBeVisible()
  await expect(dialog.getByText(/Refresh tokens are saved in macOS Keychain/)).toBeVisible()
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          __googleCalls: { command: string; args: Record<string, unknown> }[]
        }
      ).__googleCalls.find((call) => call.command === 'google_set_credential_storage'),
    ),
  ).toEqual({ command: 'google_set_credential_storage', args: { storage: 'os_store' } })
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.locator('[data-event-id="google:a:cal:one"]')).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(storage()).toHaveValue('os_store')
  await storage().selectOption('local_file')
  await expect(storage()).toHaveValue('local_file')
  await expect(dialog.getByText('Connected', { exact: true })).toBeVisible()
  await expect(
    dialog.getByText(/credentials in the inactive store are left untouched/),
  ).toBeVisible()
})

test('failed credential setting saves retain the current selection and sign-in', async ({
  page,
}) => {
  await nativePreview(page)
  await page.evaluate(() => Object.assign(window, { __failStorageChange: true }))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  const storage = dialog.getByRole('combobox', { name: 'Credential storage' })
  await storage.selectOption('os_store')
  await expect(dialog.getByRole('alert')).toHaveText(
    'Credential storage settings could not be saved.',
  )
  await expect(storage).toHaveValue('local_file')
  await expect(storage).toBeEnabled()
  await expect(dialog.getByText('Connected', { exact: true })).toBeVisible()
})

test('credential changes show their pending state until active operations finish', async ({
  page,
}) => {
  await nativePreview(page)
  await page.evaluate(() => Object.assign(window, { __holdStorageChange: true }))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  const storage = dialog.getByRole('combobox', { name: 'Credential storage' })
  await storage.selectOption('os_store')
  await expect(storage).toBeDisabled()
  await expect(dialog.getByText('Waiting for current Google operations to finish…')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Reconnect', exact: true })).toBeDisabled()
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __finishStorageChange?: () => void }).__finishStorageChange ===
      'function',
  )
  await page.evaluate(() =>
    (window as unknown as { __finishStorageChange: () => void }).__finishStorageChange(),
  )
  await expect(storage).toHaveValue('os_store')
  await expect(storage).toBeEnabled()
})

test('credential storage cannot change while Google sign-in is pending', async ({ page }) => {
  await nativePreview(page, [event], true, false, { connecting: true })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(dialog.getByRole('combobox', { name: 'Credential storage' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Cancel connection' })).toBeVisible()
})
