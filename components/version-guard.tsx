'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { unstable_isUnrecognizedActionError } from 'next/navigation'
import { toast } from 'sonner'

import { APP_BUILD, isStaleBuild, onCallError, reloadOnce } from '@/lib/app-build'
import { withBasePath } from '@/lib/base-path'

const CHECK_GAP_MS = 60_000
const POLL_MS = 10 * 60_000

function sessionStore() {
  try { return window.sessionStorage } catch { return null }
}

/**
 * Keeps a page from outliving its deployment (web and desktop alike). When the
 * server serves a newer build it shows 「Mikka 已更新 · 刷新」; when a call has
 * already hit a server action the new build removed, it reloads at once.
 */
export function VersionGuard() {
  const t = useTranslations('Common')
  useEffect(() => {
    let shown = false
    const offer = () => {
      if (shown) return
      shown = true
      toast(t('appUpdated'), { id: 'app-updated', duration: Infinity, action: { label: t('refresh'), onClick: () => { window.location.reload() } } })
    }
    let checkedAt = 0
    const check = () => {
      if (!APP_BUILD || document.visibilityState !== 'visible' || Date.now() - checkedAt < CHECK_GAP_MS) return
      checkedAt = Date.now()
      void fetch(withBasePath('/api/version'), { cache: 'no-store' })
        .then(response => response.ok ? response.json() as Promise<{ build?: unknown }> : null)
        .then(body => { if (isStaleBuild(APP_BUILD, body?.build)) offer() })
        .catch(() => {})
    }
    const failed = (error: unknown) => {
      if (!unstable_isUnrecognizedActionError(error)) return
      if (!reloadOnce(sessionStore(), Date.now(), () => { window.location.reload() })) offer()
    }
    const rejected = (event: PromiseRejectionEvent) => { failed(event.reason) }
    const off = onCallError(failed)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('unhandledrejection', rejected)
    const timer = window.setInterval(check, POLL_MS)
    return () => {
      off()
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.removeEventListener('unhandledrejection', rejected)
      window.clearInterval(timer)
    }
  }, [t])
  return null
}
