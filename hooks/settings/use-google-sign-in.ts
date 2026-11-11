'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { getPathname } from '@/i18n/navigation'
import { withBasePath } from '@/lib/base-path'
import { openSettingsInBrowser } from '@/lib/platform/open-settings'
import { useCheckOnReturn } from '@/lib/hooks/use-check-on-return'

/**
 * Signing in with Google: links a verified Google account to this Mikka
 * account. Connected apps that use Google (Gmail, Calendar) stay under
 * Integrations. Shared by both builds' 安全 pages (docs/ui-overlay.md).
 */
export function useGoogleSignIn(googleEnabled: boolean) {
  const locale = useLocale()
  const t = useTranslations('Settings.integrations')
  // Cached: coming back to 安全 shows the last answer at once and re-reads it behind.
  const accounts = useSWR(googleEnabled ? 'account:google-linked' : null, async () => {
    const { data, error } = await authClient.listAccounts()
    if (error) throw new Error('Accounts unavailable')
    return data?.some(account => account.providerId === 'google') ?? false
  }, { revalidateOnFocus: false })
  const [linkedHere, setLinkedHere] = useState(false)
  /** null while it is not known yet */
  const linked = !googleEnabled ? false : linkedHere || (accounts.data ?? null)
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState('')
  const error = actionError || (accounts.error && accounts.data === undefined ? t('googleStatusFailed') : '')
  const [success, setSuccess] = useState('')
  // Linking from the desktop finishes in the system browser: read once on the way back.
  const { mutate } = accounts
  const checkOnReturn = useCheckOnReturn(() => { void mutate() })

  useEffect(() => {
    const url = new URL(window.location.href)
    const googleResult = url.searchParams.get('google')
    if (!googleResult) return
    if (googleResult === 'linked') {
      setLinkedHere(true)
      setActionError('')
      setSuccess(t('googleLinkSuccess'))
    }
    if (googleResult === 'failed') setActionError(t('googleLinkFailed'))
    url.searchParams.delete('google')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [t])

  async function link() {
    if (!googleEnabled || linked !== false || pending) return
    setPending(true); setActionError(''); setSuccess('')
    try {
      const handoff = await openSettingsInBrowser('account')
      if (handoff === 'desktop') { setSuccess(t('linkInBrowser')); checkOnReturn(); return }
      if (handoff === 'unsupported') { setActionError(t('browserUpdateRequired')); return }
      const callbackURL = new URL(withBasePath('/api/integrations/google/callback'), window.location.origin)
      callbackURL.searchParams.set('locale', locale)
      const settingsURL = new URL(withBasePath(`${getPathname({ locale, href: '/' })}?settings=account&google=failed`), window.location.origin)
      const result = await authClient.linkSocial({ provider: 'google', callbackURL: callbackURL.href, errorCallbackURL: settingsURL.href })
      if (result.error) throw new Error()
      if (result.data?.url) window.location.assign(result.data.url)
    } catch {
      setActionError(t('googleLinkFailed'))
    } finally {
      setPending(false)
    }
  }

  return { linked, pending, error, success, link, reload: () => { setActionError(''); return mutate() } }
}
