'use client'

import { useCallback, useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { APP_BUILD, STALE_BUILD_EVENT, isStaleBuild } from '@/lib/app-build'
import { withBasePath } from '@/lib/base-path'

const CHECK_GAP_MS = 60_000

/**
 * Keeps a page from outliving its deployment (web and desktop alike). On page
 * entry and on the person's own navigation (at most once a minute; never on
 * focus or a timer, decision 2026-11-01-0400) it asks which build the server
 * runs and, when newer, shows 「Mikka 已更新 · 刷新」. A call that has already
 * hit a server action the new build removed reloads the page at once
 * (watchRemovedActions, from instrumentation-client.ts).
 */
export function VersionGuard() {
  const t = useTranslations('Common')
  const pathname = usePathname()
  const shown = useRef(false)
  const checkedAt = useRef(0)
  const offer = useCallback(() => {
    if (shown.current) return
    shown.current = true
    toast(t('appUpdated'), { id: 'app-updated', duration: Infinity, action: { label: t('refresh'), onClick: () => { window.location.reload() } } })
  }, [t])

  useEffect(() => {
    if (!APP_BUILD || shown.current || Date.now() - checkedAt.current < CHECK_GAP_MS) return
    checkedAt.current = Date.now()
    void fetch(withBasePath('/api/version'), { cache: 'no-store' })
      .then(response => response.ok ? response.json() as Promise<{ build?: unknown }> : null)
      .then(body => { if (isStaleBuild(APP_BUILD, body?.build)) offer() })
      .catch(() => {})
  }, [pathname, offer])

  // lib/app-build.ts watchRemovedActions raises this when it could not reload.
  useEffect(() => {
    window.addEventListener(STALE_BUILD_EVENT, offer)
    return () => { window.removeEventListener(STALE_BUILD_EVENT, offer) }
  }, [offer])
  return null
}
