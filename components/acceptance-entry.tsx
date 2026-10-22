'use client'

import { useState, type MouseEvent } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { withBasePath } from '@/lib/base-path'

export function AcceptanceEntry() {
  const t = useTranslations('Acceptance')
  const [blocked, setBlocked] = useState(false)
  const [pending, setPending] = useState(false)

  async function recoverSession(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    try {
      if (window.self !== window.top && typeof document.requestStorageAccess === 'function') {
        const allowed = typeof document.hasStorageAccess === 'function' && await document.hasStorageAccess()
        if (!allowed) await document.requestStorageAccess()
      }
      window.location.assign(withBasePath('/api/acceptance'))
    } catch {
      setBlocked(true)
      setPending(false)
    }
  }

  return <main className="flex min-h-svh items-center justify-center bg-background p-6">
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle><h1>{t('title')}</h1></CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <a href={withBasePath('/api/acceptance')} onClick={recoverSession} aria-disabled={pending} className="text-sm underline underline-offset-4">{pending ? t('recovering') : t('allowAndRetry')}</a>
        <a href={withBasePath('/api/acceptance')} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4">{t('openNewTab')}</a>
        <p role="status" className="text-sm text-muted-foreground">{blocked ? t('storageBlocked') : t('safeSessionNote')}</p>
      </CardContent>
      <CardFooter className="flex flex-col items-start gap-2">
        <p className="text-xs text-muted-foreground">{t('devOnly')}</p>
        <Link href="/sign-in?login=1" className="text-xs text-muted-foreground underline underline-offset-4">{t('switchAccount')}</Link>
      </CardFooter>
    </Card>
  </main>
}
