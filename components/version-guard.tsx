'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { APP_BUILD, desktopBelowMinimum, isStaleBuild, readAppVersion, markPageNeedsRefresh, subscribePageRefresh } from '@/lib/app-build'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogFooter } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { bridgeFromWindow } from '@/lib/platform/detect'

/** A known stale page stops application fetches and requires refresh. The public
 * version probe runs once a minute; drafts stay mounted until the person reloads.
 * Desktop binary minimum-version enforcement remains separate. */
export function VersionGuard() {
  return <Suspense fallback={null}><VersionGuardContent /></Suspense>
}

function VersionGuardContent() {
  const t = useTranslations('Common')
  const pathname = usePathname()
  const search = useSearchParams()?.toString()
  const [required, setRequired] = useState(false)
  const offer = useCallback(() => {
    markPageNeedsRefresh()
    setRequired(true)
  }, [])

  useEffect(() => {
    const desktop = bridgeFromWindow(window)?.app
    if (!APP_BUILD && !desktop?.requireUpdate) return
    let disposed = false
    const check = () => { void readAppVersion()
      .then(body => {
        if (disposed) return
        if (desktop?.requireUpdate && desktopBelowMinimum(desktop.version, body?.minDesktopVersion)) void desktop.requireUpdate().catch(() => {})
        if (isStaleBuild(APP_BUILD, body?.build)) offer()
      })
      .catch(() => {}) }
    check()
    // Public build metadata only: no database or third-party connection-status query.
    const timer = setInterval(check, 60_000)
    return () => { disposed = true; clearInterval(timer) }
  }, [pathname, search, offer])

  // Retain the page and offer an explicit refresh, including an early missing action.
  useEffect(() => subscribePageRefresh(window, offer), [offer])
  return <AlertDialog open={required} onOpenChange={() => {}}>
    <AlertDialogContent size="sm">
      <AlertDialogHeader><AlertDialogTitle>{t('appUpdated')}</AlertDialogTitle></AlertDialogHeader>
      <AlertDialogFooter><Button className="col-span-full" onClick={() => window.location.reload()}>{t('refresh')}</Button></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}
