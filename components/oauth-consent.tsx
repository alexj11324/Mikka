'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { createAuthClient } from 'better-auth/react'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { Loader2Icon } from 'lucide-react'
import { AuthLogo } from '@/components/blocks/auth-19/components/auth-logo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { withBasePath } from '@/lib/base-path'

// Its own client: the plugin attaches the page's signed query to every POST,
// which only this page wants.
const oauthClient = createAuthClient({ basePath: withBasePath('/api/auth'), plugins: [oauthProviderClient()] })

export function OAuthConsent({ clientName, clientUri, account }: { clientName: string | null; clientUri: string | null; account: string }) {
  const t = useTranslations('OAuthConsent')
  const [pending, setPending] = useState<'allow' | 'deny' | null>(null)
  const [error, setError] = useState('')
  const name = clientName ?? t('unknownClient')
  async function answer(accept: boolean) {
    if (pending) return
    setPending(accept ? 'allow' : 'deny'); setError('')
    try {
      const result = await oauthClient.oauth2.consent({ accept })
      const url = (result.data as { url?: string } | null)?.url
      if (result.error || !url) throw new Error('Consent failed')
      window.location.assign(url)
    } catch {
      setError(t('failed'))
      setPending(null)
    }
  }
  return (
    <main className="bg-background text-foreground flex min-h-svh w-full flex-col">
      <header className="flex items-center px-5 py-5 sm:px-8 sm:py-6 lg:px-10"><AuthLogo /></header>
      <section aria-label={t('label')} className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8 sm:py-16">
        <Card className="w-full max-w-[26rem] overflow-hidden p-0">
          <CardHeader className="px-7 pt-8 pb-5 sm:px-9 sm:pt-9 sm:pb-6">
            <CardTitle className="text-2xl font-semibold tracking-tight text-balance"><h1>{t('title', { name })}</h1></CardTitle>
            <CardDescription className="text-pretty">{t('description', { account })}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-7 sm:px-9">
            <ul className="text-muted-foreground flex list-disc flex-col gap-1 ps-5 text-sm leading-6">
              <li>{t('scopeCoordinator')}</li>
              <li>{t('scopeRead')}</li>
            </ul>
            {clientUri && <p className="text-muted-foreground text-xs break-all">{clientUri}</p>}
            {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
          </CardContent>
          <CardFooter className="flex gap-3 px-7 pt-5 pb-7 sm:px-9 sm:pb-8">
            <Button type="button" variant="outline" className="flex-1" disabled={pending !== null} onClick={() => answer(false)}>
              {pending === 'deny' && <Loader2Icon aria-hidden="true" className="animate-spin" data-icon="inline-start" />}
              {t('deny')}
            </Button>
            <Button type="button" className="flex-1" disabled={pending !== null} onClick={() => answer(true)}>
              {pending === 'allow' && <Loader2Icon aria-hidden="true" className="animate-spin" data-icon="inline-start" />}
              {t('allow')}
            </Button>
          </CardFooter>
        </Card>
      </section>
    </main>
  )
}
