'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from '@/i18n/navigation'
import useSWR from 'swr'

import { listTaskRuns } from '@/app/actions/task-runs'
import { getPreferences } from '@/app/actions/preferences'
import { chooseDesktopNotifications } from '@/app/actions/desktop-notifications'
import { desktopRunUpdate, type DesktopRun } from '@/lib/platform/desktop-notifications'
import { pushAllowed } from '@/lib/push-allowed'
import { usePlatform } from '@/lib/platform/use-platform'
import { openAppLink } from '@/components/workspace/workspace-navigation'

const POLL_MS = 15_000

function appHref(href: string): string | null {
  return href.startsWith('/') && !href.startsWith('//') ? href : null
}

/**
 * The desktop shell's only renderer-side integration. It keeps the Dock badge
 * on the runs waiting for the person. When a run enters 等你 or fails, or
 * finishes while 线程完成 is on, the Decisions API decides whether it raises a
 * system notification (app/actions/desktop-notifications.ts); clicking one
 * opens the issue. Web renders nothing.
 */
export function DesktopIntegration() {
  const platform = usePlatform()
  const desktop = platform.runtime === 'desktop'
  const router = useRouter()
  const { data } = useSWR(
    desktop ? 'task-runs' : null,
    () => listTaskRuns(),
    { refreshInterval: POLL_MS, shouldRetryOnError: false },
  )
  // Same key as Settings › 通知, so a change there applies here at once.
  const { data: preferences } = useSWR(desktop ? 'preferences' : null, getPreferences, { shouldRetryOnError: false })
  const finished = preferences !== undefined && pushAllowed(preferences, ['finished'])
  const previous = useRef<Map<string, DesktopRun['status']> | null>(null)

  useEffect(() => {
    if (!desktop || !data) return
    const bridge = window.mikka
    if (!bridge) return

    const update = desktopRunUpdate(previous.current, data, Date.now(), finished)
    previous.current = update.next
    void bridge.notifications.setBadge(update.badge).catch(() => {})
    if (!update.notifications.length) return
    // The notification id is run:<issueId>:<kind>:<stamp>.
    void chooseDesktopNotifications(update.notifications.map(notification => ({ id: notification.id, issueId: notification.id.split(':')[1], kind: notification.kind })))
      .then(result => {
        const show = new Set('show' in result && result.show ? result.show : [])
        for (const notification of update.notifications) if (show.has(notification.id)) void bridge.notifications.show(notification).catch(() => {})
      })
      .catch(() => {})
  }, [data, desktop, finished])

  useEffect(() => {
    if (!desktop) return
    const bridge = window.mikka
    if (!bridge) return
    const open = (href: string) => {
      const target = appHref(href)
      if (target && !openAppLink(target)) router.push(target)
    }
    const unsubscribe = bridge.notifications.onClick(open)
    void bridge.notifications.consumePendingClick()
      .then(href => { if (href) open(href) })
      .catch(() => {})
    return unsubscribe
  }, [desktop, router])

  return null
}
