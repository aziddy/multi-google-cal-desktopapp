import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { googleRepository } from '../data/googleRepository'

export function GoogleAccounts() {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['google', 'connection'],
    queryFn: () => googleRepository.snapshot(),
  })
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [disconnect, setDisconnect] = useState('')
  async function run(name: string, action: () => Promise<unknown>) {
    if (pending) return
    setPending(name)
    setError('')
    setMessage('')
    try {
      await client.cancelQueries({ queryKey: ['google'] })
      await action()
      setMessage(
        name === 'connect'
          ? 'Google account connected.'
          : name === 'disconnect'
            ? 'Account removed from this device.'
            : 'Google settings updated.',
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Google settings could not be updated.')
    } finally {
      setPending('')
      setDisconnect('')
      await client.invalidateQueries({ queryKey: ['google'] })
    }
  }
  const snapshot = query.data
  const connecting = pending === 'connect' || snapshot?.connecting
  return (
    <section className="settings-section google-accounts">
      <h3>Google accounts</h3>
      <p className="settings-help">
        Connect using your own Google Cloud Desktop OAuth client. Refresh tokens stay in your
        operating system’s credential store.
      </p>
      <p className="settings-help">
        {snapshot?.client
          ? `OAuth project: ${snapshot.client.projectId}`
          : 'Import a Desktop OAuth client JSON to get started.'}
      </p>
      <div className="button-row">
        <button
          className="secondary-button"
          disabled={!!pending || !!snapshot?.accounts.length || !!connecting}
          onClick={() => void run('import', () => googleRepository.importClient())}
        >
          Import OAuth JSON
        </button>
        {!snapshot?.client && (
          <button
            className="secondary-button"
            disabled={!!pending}
            onClick={() => void run('import', () => googleRepository.importClient(true))}
          >
            Use saved client
          </button>
        )}
      </div>
      {!!snapshot?.accounts.length && (
        <p className="settings-help">Disconnect all accounts before replacing the OAuth client.</p>
      )}
      <div className="google-account-list">
        {snapshot?.accounts.map((account) => (
          <div className="google-account-row" key={account.id}>
            <strong>{account.name}</strong>
            <span>{account.email}</span>
            <small>
              {account.connectionStatus === 'connected'
                ? 'Connected'
                : account.connectionStatus === 'reconnect_required'
                  ? 'Reconnect required'
                  : account.connectionStatus === 'credential_access_required'
                    ? 'Credential access required'
                    : 'Calendar list needs a refresh'}
            </small>
            <div className="button-row">
              {account.connectionStatus === 'credential_access_required' && (
                <button
                  className="dialog-text-button"
                  disabled={!!pending}
                  onClick={() =>
                    void run('credentials', () => googleRepository.retryCredentials(account.id))
                  }
                >
                  Retry credential access
                </button>
              )}
              <button
                className="dialog-text-button"
                disabled={!!pending}
                onClick={() => void run('connect', () => googleRepository.connect(account.id))}
              >
                Reconnect
              </button>
              {disconnect === account.id ? (
                <>
                  <button
                    className="dialog-danger-button"
                    disabled={!!pending}
                    onClick={() =>
                      void run('disconnect', () => googleRepository.disconnect(account.id))
                    }
                  >
                    Remove local account
                  </button>
                  <button className="dialog-text-button" onClick={() => setDisconnect('')}>
                    Keep account
                  </button>
                </>
              ) : (
                <button
                  className="dialog-text-button"
                  disabled={!!pending}
                  onClick={() => setDisconnect(account.id)}
                >
                  Disconnect
                </button>
              )}
            </div>
            {!!snapshot?.calendars.length && (
              <details className="settings-sync-details">
                <summary>Calendar sync status</summary>
                {snapshot.syncStatus.map((status) => (
                  <div className="google-account-row" key={status.calendarId}>
                    <strong>
                      {snapshot.calendars.find((cal) => cal.id === status.calendarId)?.name ??
                        'Calendar'}
                    </strong>
                    <small>
                      {status.lastSuccess
                        ? `Last refreshed ${new Date(status.lastSuccess * 1000).toLocaleString()}`
                        : 'No dates downloaded yet'}{' '}
                      · {status.coverage.filter((bucket) => bucket.complete).length} complete
                      month(s)
                    </small>
                    {status.error && <small>{status.error}</small>}
                  </div>
                ))}
              </details>
            )}
            {disconnect === account.id && (
              <p className="settings-help">
                Removes credentials and cached calendars from this device. Google events and the
                project’s Google grant remain in place.
              </p>
            )}
          </div>
        ))}
      </div>
      {connecting ? (
        <div>
          <p role="status">
            Complete sign-in in your system browser. This expires after five minutes.
          </p>
          <button
            className="secondary-button"
            onClick={() =>
              void googleRepository
                .cancelConnect()
                .then(() => client.invalidateQueries({ queryKey: ['google', 'connection'] }))
            }
          >
            Cancel connection
          </button>
        </div>
      ) : (
        <button
          className="primary-button"
          disabled={!!pending || !snapshot?.client}
          onClick={() => void run('connect', () => googleRepository.connect())}
        >
          Connect another Google account
        </button>
      )}
      {!!snapshot?.pendingMutations && (
        <div>
          <p className="settings-help">
            A previous write needs reconciliation. Check it before creating another copy.
          </p>
          <button
            className="dialog-text-button"
            disabled={!!pending}
            onClick={() => void run('recover', () => googleRepository.recoverPending())}
          >
            Reconcile previous writes
          </button>
          {snapshot.pendingWrites?.map((receipt) => (
            <div className="google-account-row" key={receipt.requestId}>
              <span>
                {receipt.title} · {receipt.operation}
              </span>
              <button
                className="secondary-button"
                disabled={!!pending}
                onClick={() =>
                  void run('recover', () => googleRepository.retryPending(receipt.requestId))
                }
              >
                Retry original attempt
              </button>
            </div>
          ))}
        </div>
      )}
      {(error || query.error) && (
        <p className="dialog-error" role="alert">
          {error || query.error?.message}
        </p>
      )}
      {message && (
        <p className="settings-help" role="status">
          {message}
        </p>
      )}
      <p className="settings-help">
        Search covers downloaded dates. Cached events remain available offline; creating and editing
        require a connection.
      </p>
    </section>
  )
}
