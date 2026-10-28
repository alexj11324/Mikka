'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { DAEMON_CLIENT_ID } from '@mikka/protocol/auth'
import { AuthLogo } from '@/components/blocks/auth-19/components/auth-logo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Link } from '@/i18n/navigation'
import { withBasePath } from '@/lib/base-path'

type State = 'entry' | 'loading' | 'review' | 'approving' | 'denying' | 'approved' | 'denied' | 'invalid' | 'error'
const primary = 'bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90'

export function DeviceAuthorization({ account, initialCode }: { account: string; initialCode: string }) {
  const t = useTranslations('DeviceAuthorization')
  const [code, setCode] = useState(initialCode)
  const [state, setState] = useState<State>(initialCode ? 'loading' : 'entry')
  const pending = state === 'loading' || state === 'approving' || state === 'denying'

  const review = useCallback(async (value: string, signal?: AbortSignal) => {
    const normalized = value.trim().toUpperCase().replace(/\s/g, '')
    setCode(normalized)
    if (!/^[A-Z0-9-]{4,32}$/.test(normalized)) { setState('invalid'); return }
    setState('loading')
    try {
      const response = await fetch(withBasePath('/api/auth/device') + '?user_code=' + encodeURIComponent(normalized), {
        credentials: 'same-origin', cache: 'no-store', signal,
      })
      if (signal?.aborted) return
      if (!response.ok) { setState(response.status < 500 ? 'invalid' : 'error'); return }
      const data = await response.json() as { client_id?: string; status?: string }
      if (signal?.aborted) return
      // Better Auth binds review to the signed-in owner. A grant owned by
      // someone else does not disclose client_id and cannot be approved here.
      if (data.client_id !== DAEMON_CLIENT_ID) { setState('invalid'); return }
      setState(data.status === 'pending' ? 'review' : data.status === 'approved' ? 'approved' : data.status === 'denied' ? 'denied' : 'invalid')
    } catch {
      if (!signal?.aborted) setState('error')
    }
  }, [])

  useEffect(() => {
    if (!initialCode) return
    const controller = new AbortController()
    void review(initialCode, controller.signal)
    return () => controller.abort()
  }, [initialCode, review])

  async function answer(allow: boolean) {
    if (state !== 'review') return
    setState(allow ? 'approving' : 'denying')
    try {
      const response = await fetch(withBasePath('/api/auth/device/' + (allow ? 'approve' : 'deny')), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userCode: code }),
      })
      setState(response.ok ? (allow ? 'approved' : 'denied') : response.status < 500 ? 'invalid' : 'error')
    } catch { setState('error') }
  }

  const title = state === 'approved' ? t('approved') : state === 'denied' ? t('denied') : t('title')
  return <main className="flex min-h-svh w-full flex-col bg-background text-foreground">
    <header className="flex items-center px-5 py-5 sm:px-8 sm:py-6 lg:px-10"><AuthLogo /></header>
    <section className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8 sm:py-16" aria-label={t('title')}>
      <Card className="w-full max-w-[24.5rem] gap-4 p-6 ring-0">
        <CardHeader className="gap-4 p-0">
          <CardTitle><h1>{title}</h1></CardTitle>
          <p className="break-all text-sm text-muted-foreground">{account}</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 p-0">
        {state === 'entry' && <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void review(code) }}>
          <FieldGroup><Field>
            <FieldLabel htmlFor="device-code">{t('code')}</FieldLabel>
            <Input id="device-code" autoFocus autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} value={code} placeholder="ABCD-EFGH" onChange={event => setCode(event.target.value)} />
          </Field></FieldGroup>
          <Button type="submit" size="sm" className={primary + ' self-start'} disabled={!code.trim()}>{t('continue')}</Button>
        </form>}
        {state === 'loading' && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner aria-hidden="true" />{t('loading')}</p>}
        {(state === 'review' || state === 'approving' || state === 'denying') && <>
          <div className="flex flex-col gap-4">
            <p className="text-xs text-muted-foreground">{t('code')}</p>
            <p className="font-mono text-2xl">{code}</p>
            <p className="text-sm">{t('scope')}</p>
          </div>
          <div className="flex gap-3">
            <Button size="sm" variant="outline" disabled={pending} onClick={() => { void answer(false) }}>{state === 'denying' && <Spinner aria-hidden="true" data-icon="inline-start" />}{t('deny')}</Button>
            <Button size="sm" className={primary} disabled={pending} onClick={() => { void answer(true) }}>{state === 'approving' && <Spinner aria-hidden="true" data-icon="inline-start" />}{state === 'approving' ? t('approving') : t('allow')}</Button>
          </div>
        </>}
        {state === 'approved' && <p className="text-sm">{t('returnToTerminal')}</p>}
        {(state === 'approved' || state === 'denied') && <Button size="sm" className={primary + ' self-start'} render={<Link href="/settings?section=devices" />}>{t('done')}</Button>}
        {(state === 'invalid' || state === 'error') && <>
          <p role="alert" className="text-sm text-destructive">{state === 'invalid' ? t('invalid') : t('failed')}</p>
          <Button size="sm" variant="outline" className="self-start" onClick={() => {
            if (state === 'invalid') { setCode(''); setState('entry') }
            else void review(code)
          }}>{state === 'invalid' ? t('enterAgain') : t('retry')}</Button>
        </>}
        </CardContent>
      </Card>
    </section>
  </main>
}
