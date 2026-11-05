'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from '@/i18n/navigation'
import useSWR from 'swr'

import { listDevices } from '@/app/actions/agents'
import { localSetupAction } from '@/lib/local-device-setup'
import { getPreferences } from '@/app/actions/preferences'
import { chooseDesktopNotifications } from '@/app/actions/desktop-notifications'
import { desktopRunUpdate, type DesktopRun } from '@/lib/platform/desktop-notifications'
import { pushAllowed } from '@/lib/push-allowed'
import { usePlatform } from '@/lib/platform/use-platform'
import { useLiveTaskRunList } from '@/hooks/use-live-lists'
import { openAppLink } from '@/components/workspace/workspace-navigation'

function appHref(href: string): string | null {
  return href.startsWith('/') && !href.startsWith('//') ? href : null
}

/**
 * The desktop shell's only renderer-side integration. It keeps the Dock badge
 * on the runs waiting for the person. When a run enters 等你 or fails, or
 * finishes while 线程完成 is on, the Decisions API decides whether it raises a
 * system notification (app/actions/desktop-notifications.ts); clicking one
 * opens that thread beside its task. Web renders nothing.
 */
export function DesktopIntegration({ userId }: { userId: string }) {
  const platform = usePlatform()
  // A web renderer never mounts the reader or its live subscription. Each
  // signed-in owner also starts with their own notification baseline.
  return platform.runtime === 'desktop' ? <DesktopSession key={userId} userId={userId} /> : null
}

function DesktopSession({ userId }: { userId: string }) {
  const router = useRouter()
  const { data } = useLiveTaskRunList(userId)
  // Same key as Settings › 通知, so a change there applies here at once.
  const { data: preferences } = useSWR('preferences', getPreferences, { shouldRetryOnError: false })
  const finished = preferences !== undefined && pushAllowed(preferences, ['finished'])
  const previous = useRef<Map<string, DesktopRun['status']> | null>(null)
  const lifetime = useRef(0)
  useEffect(() => {
    lifetime.current++
    return () => { lifetime.current++ }
  }, [])

  useEffect(() => {
    if (!data) return
    const bridge = window.mikka
    if (!bridge) return

    const update = desktopRunUpdate(previous.current, data.items, Date.now(), finished)
    previous.current = update.next
    void bridge.notifications.setBadge(update.badge).catch(() => {})
    if (!update.notifications.length) return
    const generation = lifetime.current
    // The notification id is run:<issueId>:<kind>:<stamp>.
    void chooseDesktopNotifications(update.notifications.map(notification => ({ id: notification.id, issueId: notification.id.split(':')[1], kind: notification.kind })))
      .then(result => {
        if (lifetime.current !== generation) return
        const show = new Set('show' in result && result.show ? result.show : [])
        for (const notification of update.notifications) if (show.has(notification.id)) void bridge.notifications.show(notification).catch(() => {})
      })
      .catch(() => {})
  }, [data, finished])

  useEffect(() => {
    const bridge = window.mikka
    if (!bridge) return
    let live = true
    const open = (href: string) => {
      if (!live) return
      const target = appHref(href)
      if (target && !openAppLink(target)) router.push(target)
    }
    const unsubscribe = bridge.notifications.onClick(open)
    void bridge.notifications.consumePendingClick()
      .then(href => { if (href) open(href) })
      .catch(() => {})
    return () => { live = false; unsubscribe() }
  }, [router])

  // Installing the app makes this computer a device (Alex, 2026-11-02): once per
  // signed-in account, when it is not yet one of mine and online, main installs or restarts
  // its daemon in the background. Progress shows on 设置 › 设备.
  useEffect(() => {
    const bridge = window.mikka
    if (!bridge?.ssh?.autoLocal) return
    let live = true
    void Promise.all([bridge.device.status(), listDevices()])
      .then(([local, devices]) => {
        const action = localSetupAction(local, devices.map(device => device.id))
        if (live && action !== 'none') return bridge.ssh?.autoLocal?.(action)
      })
      .catch(() => {})
    return () => { live = false }
  }, [userId])

  return null
}
