'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { useTheme } from 'next-themes'
import { useLocale, useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { usePathname, useRouter } from '@/i18n/navigation'
import { getIssuePrefixState, saveIssuePrefix } from '@/app/actions/issue-prefix'
import { resetOnboarding } from '@/app/actions/onboarding'
import { settingsRead } from '@/lib/settings-read'
import { settingsKeys } from '@/lib/swr/keys'
import { withBasePath } from '@/lib/base-path'
import { useActionError } from '@/lib/use-action-error'

// 偏好设置's reads and saves, shared by the open-source page and the hosted
// layer (docs/ui-overlay.md): appearance, language, the task prefix and
// 重新播放引导.

export type AppTheme = 'light' | 'dark' | 'system'
export type AppLocale = 'zh-CN' | 'en'

/** The theme next-themes keeps; unknown until mounted, as the server cannot know it. */
export function useAppearance() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  return { mounted, theme: mounted ? (theme as AppTheme | undefined) : undefined, setTheme: (next: AppTheme) => setTheme(next) }
}

/** D14: switching the interface language. The choice is remembered in NEXT_LOCALE. */
export function useLocaleSwitch() {
  const locale = useLocale() as AppLocale
  const pathname = usePathname()
  const params = useSearchParams()
  const router = useRouter()
  function switchTo(next: AppLocale | undefined) {
    if (!next || next === locale) return
    // Keep ?section= and ?workspace=, so the person stays on this page in this workspace.
    router.replace({ pathname, query: Object.fromEntries(params) }, { locale: next })
  }
  return { locale, switchTo }
}

type PrefixState = Awaited<ReturnType<typeof getIssuePrefixState>>

/** The four-letter prefix personal tasks show (MIK-46), e.g. ALEX-12. */
export function useIssuePrefix() {
  const t = useTranslations('Settings.issuePrefix')
  // Cached: a return to 偏好 shows the saved prefix at once and re-reads it behind.
  const read = useSWR(settingsKeys.issuePrefix(), () => settingsRead<PrefixState>('issue-prefix'))
  const state: PrefixState | null = read.data ?? null
  const shown = (next: PrefixState | null) => next?.prefix ?? next?.saved ?? next?.suggested ?? ''
  /** What the person typed; null shows the saved prefix. */
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? shown(state)
  const [busy, setBusy] = useState(false)
  const [actionMessage, setMessage] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null)
  const message = actionMessage ?? (read.error && !read.data ? { kind: 'error' as const, text: t('loadError') } : null)

  async function save() {
    setBusy(true); setMessage(null)
    try {
      const result = await saveIssuePrefix({ prefix: value })
      if ('error' in result) { setMessage({ kind: 'error', text: result.error === 'issuePrefixTaken' ? t('taken') : t('invalid') }); return }
      await read.mutate()
      setDraft(null)
      setMessage({ kind: 'saved', text: t('saved', { example: `${result.prefix}-12` }) })
    } catch { setMessage({ kind: 'error', text: t('saveError') }) }
    finally { setBusy(false) }
  }

  const unchanged = value.trim().toUpperCase() === state?.prefix
  /** Saves when the field is left or on Enter; an incomplete prefix goes back to the saved one. */
  function commit() {
    if (!state || busy || unchanged) return
    if (value.length === 4) { void save(); return }
    if (state.prefix) setDraft(null)
  }
  return {
    state, value, busy, message, commit,
    /** Letters only, upper case, as typed */
    type: (typed: string) => setDraft(typed.replace(/[^a-z]/gi, '').toUpperCase()),
    /** Esc: back to the saved prefix */
    reset: () => { if (state) setDraft(null) },
    description: state && !state.prefix ? t('needsChoice') : t('current', { example: `${state?.prefix ?? 'ALEX'}-12` }),
  }
}

/**
 * 重新播放引导 (docs/design/onboarding.md §3): clears this person's completion
 * (`resetOnboarding`) and reloads the app, which shows the first-run guide again.
 */
export function useReplayOnboarding() {
  const actionError = useActionError()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function replay() {
    setPending(true)
    setError(null)
    try {
      await resetOnboarding()
      window.location.assign(withBasePath('/'))
    } catch {
      setError(actionError())
      setPending(false)
    }
  }
  return { pending, error, replay }
}
