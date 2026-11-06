'use client'

import { useTranslations } from 'next-intl'
import { Loader2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Item, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item'
import { UserAvatar } from '@/components/user-avatar'

export type SignedInAccount = { name?: string | null; email: string; image?: string | null }

/**
 * The desktop app asked this browser to sign in, and the browser already has a
 * web session. The app gets that account only after the person sees it here;
 * 换个账号 goes to the provider's account picker instead. Drawn in the sign-in
 * card's frame (SignInCard).
 */
export function DesktopAccountChoice({ account, continueHref, pending, error, onSwitch }: {
  account: SignedInAccount
  /** /api/desktop/return for this handoff: binds the session to the app's request. */
  continueHref: string
  pending: boolean
  error: string
  onSwitch: () => void
}) {
  const t = useTranslations('Auth')
  const name = account.name?.trim() || account.email
  return (
    <Card className="w-full max-w-[26rem] overflow-hidden p-0">
      <CardHeader className="px-7 pt-8 pb-5 sm:px-9 sm:pt-9 sm:pb-6">
        <CardTitle className="text-2xl font-semibold tracking-tight text-balance">
          <h1>{t('welcome')}</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 px-7 pb-7 sm:px-9 sm:pb-8">
        <Item variant="muted" size="sm">
          <ItemMedia><UserAvatar user={account} /></ItemMedia>
          <ItemContent className="min-w-0"><ItemTitle className="break-all">{account.email}</ItemTitle></ItemContent>
        </Item>
        {error && <p role="alert" className="text-destructive-foreground text-sm">{error}</p>}
        <div className="flex flex-col gap-3">
          <Button className="w-full" nativeButton={false} role="link" data-testid="desktop-continue" render={<a href={continueHref} />}>
            {t('continueAs', { name })}
          </Button>
          <Button type="button" variant="outline" className="w-full" disabled={pending} data-testid="desktop-switch-account" onClick={onSwitch}>
            {pending && <Loader2Icon aria-hidden="true" className="animate-spin" data-icon="inline-start" />}
            {t('switchAccount')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
