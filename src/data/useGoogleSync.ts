import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { googleRepository } from './googleRepository'
import type { Calendar, DateRange } from '../domain/types'
import { utcMonthBuckets } from '../domain/calendar'

/** Only the visible view's complete month buckets are refreshed. */
export function useGoogleSync(
  enabled: boolean,
  calendars: Calendar[],
  hidden: string[],
  range: DateRange,
) {
  const client = useQueryClient()
  const [activeSyncs, setActiveSyncs] = useState(0)
  const required = useMemo(() => utcMonthBuckets(range), [range])
  const signature = JSON.stringify({
    calendars: calendars.filter((cal) => !hidden.includes(cal.id)).map((cal) => cal.id),
    buckets: required,
  })
  const status = useQuery({
    queryKey: ['google', 'snapshot'],
    queryFn: () => googleRepository.snapshot(),
    enabled,
  })
  const needsRecovery = (status.data?.pendingMutations ?? 0) > 0
  useEffect(() => {
    if (!enabled || !needsRecovery) return
    let disposed = false
    void googleRepository
      .recoverPending()
      .then(() => {
        if (!disposed) void client.invalidateQueries({ queryKey: ['google'] })
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [client, enabled, needsRecovery])
  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let running = false
    const args = JSON.parse(signature) as { calendars: string[]; buckets: DateRange[] }
    if (!args.calendars.length) return
    const sync = async () => {
      if (document.visibilityState === 'hidden' || running) return
      running = true
      setActiveSyncs((count) => count + 1)
      try {
        await Promise.allSettled(
          args.calendars.map((calendar) => googleRepository.sync(calendar, args.buckets)),
        )
        if (!disposed) await client.invalidateQueries({ queryKey: ['google'] })
      } finally {
        running = false
        setActiveSyncs((count) => count - 1)
      }
    }
    const focus = () => {
      void sync()
    }
    void sync()
    const timer = window.setInterval(focus, 60_000)
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', focus)
    }
  }, [client, enabled, signature])
  async function refresh() {
    if (!enabled) return
    setActiveSyncs((count) => count + 1)
    try {
      const snapshot = await googleRepository.refreshAccounts()
      await Promise.allSettled(
        snapshot.calendars
          .filter((cal) => !hidden.includes(cal.id))
          .map((cal) => googleRepository.sync(cal.id, required, true)),
      )
      await client.invalidateQueries({ queryKey: ['google'] })
    } finally {
      setActiveSyncs((count) => count - 1)
    }
  }
  const visible =
    status.data?.syncStatus.filter((state) =>
      calendars.some((cal) => cal.id === state.calendarId && !hidden.includes(cal.id)),
    ) ?? []
  const missing = visible.filter((state) =>
    required.some(
      (bucket) =>
        !state.coverage.some((cover) => cover.startDate === bucket.startDate && cover.complete),
    ),
  )
  const failures = visible.filter((state) => state.error)
  return { syncing: activeSyncs > 0, status: status.data, missing, failures, refresh }
}
