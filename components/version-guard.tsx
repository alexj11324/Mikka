'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { ACTION_NOT_FOUND_HEADER, APP_BUILD, isStaleBuild, reloadOnce } from '@/lib/app-build'
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
    // Server actions go through window.fetch. Watching the response catches a
    // removed action however its caller handles the error.
    const original = window.fetch
    const watched: typeof window.fetch = async (...args) => {
      const response = await original(...args)
      if (response.headers.has(ACTION_NOT_FOUND_HEADER) && !reloadOnce(sessionStore(), Date.now(), () => { window.location.reload() })) offer()
      return response
    }
    window.fetch = watched
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    const timer = window.setInterval(check, POLL_MS)
    return () => {
      if (window.fetch === watched) window.fetch = original
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.clearInterval(timer)
    }
  }, [t])
  return null
}
