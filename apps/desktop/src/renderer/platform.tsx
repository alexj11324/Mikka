import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { AuthCard } from '@/components/blocks/auth-19/components/auth-card'
import { Button, buttonVariants } from '@/components/ui/button'
import { safeAuthReturn } from '@/lib/auth-return'
import { rendererHost } from './host'
import { Link } from './i18n-navigation'
import { localeHref, localeOf, useLocation } from './location'
import { openCurrentPageInBrowser } from './open-settings'
import type { BootstrapScope } from './bootstrap'

export { AuthForm } from './auth-form'
export { setSession } from './auth-client'
export const platform = 'desktop' as const
export function bootstrapScope(_location: URL): BootstrapScope { return 'workspace' }
export function PlatformExtras() { return null }
export function onSessionChanged(listener: () => void) { return rendererHost().onSessionChanged(listener) }
export function authenticatedReturn(location: URL) {
  return location.searchParams.get('addAccount') === '1' ? null : localeHref(safeAuthReturn(location.searchParams.get('next') ?? undefined), localeOf(location.pathname))
}
export function requireUpdate() { void window.mikka?.app.requireUpdate?.() }

export function BrowserRoute({ signUp = false }: { signUp?: boolean; account?: string | null }) {
  const t = useTranslations('DesktopRenderer')
  const [failed, setFailed] = useState(false)
  const location = useLocation()
  const open = useCallback(() => {
    setFailed(false)
    if (signUp) void rendererHost().signIn({ mode: 'sign-up', next: safeAuthReturn(location.searchParams.get('next') ?? undefined), locale: localeOf(location.pathname), addAccount: location.searchParams.get('addAccount') === '1' }).catch(() => setFailed(true))
    else void openCurrentPageInBrowser().then(result => setFailed(result !== 'desktop')).catch(() => setFailed(true))
  }, [signUp, location.href])
  useEffect(open, [open])
  return <Auth><AuthCard title={t('browserTitle')} description={t(failed ? 'browserFailed' : 'browserOpened')}>
    <Button onClick={open}>{t('openBrowser')}</Button><Link href="/" className={buttonVariants({ variant: 'ghost' })}>{t('back')}</Link>
  </AuthCard></Auth>
}
