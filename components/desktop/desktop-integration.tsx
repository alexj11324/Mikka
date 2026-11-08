'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from '@/i18n/navigation'

import { listDevices } from '@/app/actions/agents'
import { localSetupAction, localSetupNeedsOwnership } from '@/lib/local-device-setup'
import { chooseDesktopNotifications } from '@/app/actions/desktop-notifications'
import { desktopRunUpdate, type DesktopRun } from '@/lib/platform/desktop-notifications'
import { usePlatform } from '@/lib/platform/use-platform'
import { openAppLink } from '@/components/workspace/workspace-navigation'
import { useLiveTaskRunList } from '@/hooks/use-live-lists'

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
  const desktop = platform.runtime === 'desktop'
  const router = useRouter()
  // The board's own run list and live key (#1212): a run entering 等你, failing or finishing pushes
  // task_run_list on the owner's home channel; a lease running out is its read deadline. No timer reads it.
  const runs = useLiveTaskRunList(userId, desktop)
  const data = runs.data?.items
  const previous = useRef<Map<string, DesktopRun['status']> | null>(null)
  const lifetime = useRef(0)

  useEffect(() => {
    lifetime.current++
    return () => { lifetime.current++ }
  }, [desktop, userId])

  useEffect(() => {
    if (!desktop || !data) return
    const bridge = window.mikka
    if (!bridge) return

    // The launch baseline needs no notification preferences. Only an actual
    // completion asks the server to check the person's current switch, before
    // its decision; a client cache cannot keep an old on/off setting alive.
    const update = desktopRunUpdate(previous.current, data, Date.now(), true)
    previous.current = update.next
    void bridge.notifications.setBadge(update.badge).catch(() => {})
    if (!update.notifications.length) return
    const current = lifetime.current
    // The notification id is run:<issueId>:<kind>:<stamp>.
    void chooseDesktopNotifications(update.notifications.map(notification => ({ id: notification.id, issueId: notification.id.split(':')[1], kind: notification.kind })))
      .then(result => {
        // A decision can finish after this account's integration unmounted.
        if (lifetime.current !== current) return
        const show = new Set('show' in result && result.show ? result.show : [])
        for (const notification of update.notifications) if (show.has(notification.id)) void bridge.notifications.show(notification).catch(() => {})
      })
      .catch(() => {})
  }, [data, desktop])

  useEffect(() => {
    if (!desktop) return
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
  }, [desktop, router, userId])

  // Installing the app makes this computer a device (Alex, 2026-11-02): once per
  // signed-in account, when it is not yet one of mine and online, main installs or restarts
  // its daemon in the background. Progress shows on 设置 › 设备.
  useEffect(() => {
    if (!desktop) return
    const bridge = window.mikka
    if (!bridge?.ssh?.autoLocal) return
    let live = true
    void bridge.device.status()
      .then(async local => {
        if (!live) return
        const ids = localSetupNeedsOwnership(local) ? (await listDevices()).map(device => device.id) : []
        const action = localSetupAction(local, ids)
        if (live && action !== 'none') return bridge.ssh?.autoLocal?.(action)
      })
      .catch(() => {})
    return () => { live = false }
  }, [desktop, userId])

  return null
}
