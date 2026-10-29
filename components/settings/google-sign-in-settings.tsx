'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { getPathname } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { withBasePath } from '@/lib/base-path'
import { Google } from '@/components/ui/svgs/google'

// Signing in with Google: links a verified Google account to this Mikka
// account. Connected apps that use Google (Gmail, Calendar) stay under
// Integrations.
export function GoogleSignInSettings({ googleEnabled }: { googleEnabled: boolean }) {
  const locale = useLocale()
  const t = useTranslations('Settings.integrations')
  const [googleLinked, setGoogleLinked] = useState<boolean | null>(null)
  const [googlePending, setGooglePending] = useState(false)
  const [googleError, setGoogleError] = useState('')
  const [googleSuccess, setGoogleSuccess] = useState('')

  useEffect(() => {
    if (!googleEnabled) { setGoogleLinked(false); return }
    let current = true
    void authClient.listAccounts().then(({ data, error: resultError }) => {
      if (!current) return
      if (resultError) {
        setGoogleError(t('googleStatusFailed'))
        setGoogleLinked(false)
      } else {
        setGoogleError('')
        setGoogleLinked(data?.some(account => account.providerId === 'google') ?? false)
      }
    }).catch(() => {
      if (!current) return
      setGoogleError(t('googleStatusFailed'))
      setGoogleLinked(false)
    })
    return () => { current = false }
  }, [googleEnabled, t])

  useEffect(() => {
    const url = new URL(window.location.href)
    const googleResult = url.searchParams.get('google')
    if (!googleResult) return
    if (googleResult === 'linked') {
      setGoogleLinked(true)
      setGoogleError('')
      setGoogleSuccess(t('googleLinkSuccess'))
    }
    if (googleResult === 'failed') setGoogleError(t('googleLinkFailed'))
    url.searchParams.delete('google')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [t])

  async function linkGoogle() {
    setGooglePending(true); setGoogleError(''); setGoogleSuccess('')
    try {
      const callbackURL = new URL(withBasePath('/api/integrations/google/callback'), window.location.origin)
      callbackURL.searchParams.set('locale', locale)
      const settingsURL = new URL(withBasePath(`${getPathname({ locale, href: '/' })}?settings=account&google=failed`), window.location.origin)
      const result = await authClient.linkSocial({ provider: 'google', callbackURL: callbackURL.href, errorCallbackURL: settingsURL.href })
      if (result.error) throw new Error()
      if (result.data?.url) window.location.assign(result.data.url)
    } catch {
      setGoogleError(t('googleLinkFailed'))
      setGooglePending(false)
    }
  }

  return <SettingsSection id="google-sign-in-heading" title={t('googleSignInTitle')} description={t('googleSignInDescription')}>
    <SettingRow title={t('googleSignIn')} description={googleLinked ? t('googleLinkedDescription') : t('googleLinkDescription')}>
      <div className="flex items-center gap-3">
        {googleLinked && <span className="text-xs text-muted-foreground">{t('googleLinked')}</span>}
        {!googleLinked && <Button type="button" variant="secondary" size="sm" disabled={!googleEnabled || googleLinked === null || googlePending} onClick={() => void linkGoogle()}>
          <Google className="size-4" />{googlePending ? t('googleLinking') : t('linkGoogle')}
        </Button>}
      </div>
    </SettingRow>
    {!googleEnabled && <p role="status" className="px-5 py-3 text-sm text-muted-foreground">{t('googleNotConfigured')}</p>}
    {googleSuccess && <p role="status" className="px-5 py-3 text-sm text-muted-foreground">{googleSuccess}</p>}
    {googleError && <p role="alert" className="px-5 py-3 text-sm text-destructive">{googleError}</p>}
  </SettingsSection>
}
