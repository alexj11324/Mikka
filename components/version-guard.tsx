'use client'

import { Suspense, useCallback, useEffect, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { APP_BUILD, STALE_BUILD_EVENT, desktopBelowMinimum, isStaleBuild, readAppVersion } from '@/lib/app-build'
import { bridgeFromWindow } from '@/lib/platform/detect'

/**
 * Keeps a page from outliving its deployment (web and desktop alike). On page
 * entry and on the person's own navigation (at most once a minute; never on
 * focus or a timer, decision 2026-11-01-0400) it asks which build the server
 * runs and, when newer, shows 「Mikka 已更新 · 刷新」. A call that has already
 * hit a server action the new build removed reloads the page at once
 * (watchRemovedActions, from instrumentation-client.ts). In the desktop app,
 * a build older than the server's minDesktopVersion asks main to update first.
 */
export function VersionGuard() {
  return <Suspense fallback={null}><VersionGuardContent /></Suspense>
}

function VersionGuardContent() {
  const t = useTranslations('Common')
  const pathname = usePathname()
  const search = useSearchParams()?.toString()
  const shown = useRef(false)
  const offer = useCallback(() => {
    if (shown.current) return
    shown.current = true
    toast(t('appUpdated'), { id: 'app-updated', duration: Infinity, action: { label: t('refresh'), onClick: () => { window.location.reload() } } })
  }, [t])

  useEffect(() => {
    const desktop = bridgeFromWindow(window)?.app
    if (!APP_BUILD && !desktop?.requireUpdate) return
    void readAppVersion()
      .then(body => {
        if (desktop?.requireUpdate && desktopBelowMinimum(desktop.version, body?.minDesktopVersion)) void desktop.requireUpdate().catch(() => {})
        if (isStaleBuild(APP_BUILD, body?.build)) offer()
      })
      .catch(() => {})
  }, [pathname, search, offer])

  // lib/app-build.ts watchRemovedActions raises this when it could not reload.
  useEffect(() => {
    window.addEventListener(STALE_BUILD_EVENT, offer)
    return () => { window.removeEventListener(STALE_BUILD_EVENT, offer) }
  }, [offer])
  return null
}
