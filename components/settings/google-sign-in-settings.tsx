'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { SettingRow, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { Google } from '@/components/ui/svgs/google'
import { useGoogleSignIn } from '@/hooks/settings/use-google-sign-in'

// Signing in with Google: links a verified Google account to this Mikka
// account (hooks/settings/use-google-sign-in.ts).
export function GoogleSignInSettings({ googleEnabled }: { googleEnabled: boolean }) {
  const t = useTranslations('Settings.integrations')
  const common = useTranslations('Common')
  const { linked: googleLinked, pending: googlePending, error: googleError, success: googleSuccess, link: linkGoogle, reload } = useGoogleSignIn(googleEnabled)

  return <SettingsSection id="google-sign-in-heading" title={t('googleSignInTitle')}>
    <SettingRow title={t('googleSignIn')}>
      <div className="flex items-center gap-3">
        {googleLinked && <span className="text-xs text-muted-foreground">{t('googleLinked')}</span>}
        {!googleLinked && <Button type="button" variant="secondary" size="sm" disabled={!googleEnabled || googleLinked === null || googlePending} onClick={() => void linkGoogle()}>
          <Google className="size-4" />{googlePending ? t('googleLinking') : t('linkGoogle')}
        </Button>}
      </div>
    </SettingRow>
    {!googleEnabled && <p role="status" className="px-5 py-3 text-sm text-muted-foreground">{t('googleNotConfigured')}</p>}
    {googleSuccess && <p role="status" className="px-5 py-3 text-sm text-muted-foreground">{googleSuccess}</p>}
    {googleError && <SettingsSaveError message={googleError} retryLabel={common('retry')} onRetry={() => { void reload() }} />}
  </SettingsSection>
}
