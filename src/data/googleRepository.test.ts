import { describe, expect, it, vi } from 'vitest'
import type { CalendarEvent, EventInput } from '../domain/types'

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke }))
import { changedFields, GoogleRepository, type GoogleSnapshot } from './googleRepository'

const event: CalendarEvent = {
  id: 'google:event',
  accountId: 'account',
  calendarId: 'calendar',
  title: 'Original',
  start: '2026-10-26T14:00:00Z',
  end: '2026-10-26T15:00:00Z',
  allDay: false,
  timeZone: 'America/Chicago',
  location: 'Old location',
  description: '  untouched markup <b>text</b>  ',
  provider: 'google',
  etag: '"v1"',
  capabilities: { edit: true, delete: true },
}
function input(overrides: Partial<EventInput> = {}): EventInput {
  return {
    accountId: event.accountId,
    calendarId: event.calendarId,
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    timeZone: event.timeZone,
    description: event.description,
    location: event.location,
    ...overrides,
  }
}
describe('Google repository boundary', () => {
  it('changes credential storage without exposing tokens and rejects stale snapshots', async () => {
    const original: GoogleSnapshot = {
      credentialStorage: 'local_file',
      client: null,
      accounts: [],
      calendars: [],
      events: [],
      syncStatus: [],
      connecting: false,
      pendingMutations: 0,
    }
    const updated: GoogleSnapshot = { ...original, credentialStorage: 'os_store' }
    let finishSnapshot!: (snapshot: GoogleSnapshot) => void
    bridge.invoke
      .mockImplementationOnce(
        () =>
          new Promise<GoogleSnapshot>((resolve) => {
            finishSnapshot = resolve
          }),
      )
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce(updated)
    const repo = new GoogleRepository()
    const snapshot = repo.snapshot()
    await expect(repo.setCredentialStorage('os_store')).resolves.toEqual(updated)
    expect(bridge.invoke).toHaveBeenNthCalledWith(2, 'google_set_credential_storage', {
      storage: 'os_store',
    })
    finishSnapshot(original)
    await expect(snapshot).resolves.toEqual(updated)
    expect(bridge.invoke).toHaveBeenLastCalledWith('google_snapshot', undefined)
  })

  it('preserves actionable native credential-settings errors', async () => {
    bridge.invoke.mockRejectedValueOnce({
      code: 'CREDENTIAL_SETTINGS',
      message: 'Credential storage settings could not be saved.',
    })
    await expect(new GoogleRepository().setCredentialStorage('local_file')).rejects.toMatchObject({
      code: 'CREDENTIAL_SETTINGS',
      message: 'Credential storage settings could not be saved.',
    })
  })

  it('preserves untouched fields and gives clearing an explicit null', () => {
    expect(changedFields(event, input({ title: 'Changed', location: undefined }))).toEqual({
      title: 'Changed',
      location: null,
    })
    expect(changedFields(event, input({ end: '2026-10-26T16:00:00Z' }))).toEqual({
      timing: {
        start: event.start,
        end: '2026-10-26T16:00:00Z',
        allDay: false,
        timeZone: event.timeZone,
      },
    })
    expect(changedFields(event, input())).toEqual({})
    expect(() => changedFields(event, input({ calendarId: 'other' }))).toThrow(
      'Moving Google events',
    )
  })
  it('sends the original ETag and an explicit occurrence scope', async () => {
    bridge.invoke.mockResolvedValueOnce(event)
    await new GoogleRepository().updateEvent(event.id, input({ title: 'Changed' }), { event })
    expect(bridge.invoke).toHaveBeenLastCalledWith('google_mutate', {
      mutation: expect.objectContaining({
        expectedEtag: '"v1"',
        scope: 'occurrence',
        changes: { title: 'Changed' },
      }),
    })
  })
  it('preserves a creation attempt ID across retries and exposes structured conflicts', async () => {
    const repo = new GoogleRepository()
    bridge.invoke.mockRejectedValueOnce({ code: 'UNCERTAIN_WRITE', message: 'Reconcile first' })
    await expect(repo.createEvent(input(), { requestId: 'stable-attempt' })).rejects.toMatchObject({
      code: 'UNCERTAIN_WRITE',
    })
    bridge.invoke.mockResolvedValueOnce(event)
    await repo.createEvent(input(), { requestId: 'stable-attempt' })
    expect(bridge.invoke).toHaveBeenLastCalledWith('google_mutate', {
      mutation: expect.objectContaining({ requestId: 'stable-attempt' }),
    })
  })
})
