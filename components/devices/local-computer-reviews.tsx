'use client'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { withBasePath } from '@/lib/base-path'
import type { LocalComputerRequest } from '@mikka/protocol/computer'
type Review = Omit<LocalComputerRequest, 'expiresAt'> & { expiresAt: string; device: string }
export function LocalComputerReviews() {
  const t = useTranslations('ComputerApprovals')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const { data, error, mutate } = useSWR<{ requests: Review[] }>('/api/devices/computer', async url => {
    const response = await fetch(withBasePath(url), { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) throw new Error(t('failed'))
    return response.json()
  }, { refreshInterval: 2000, refreshWhenHidden: false })
  async function decide(row: Review, approve: boolean) {
    if (busy) return
    setBusy(row.id)
    try {
      const response = await fetch(withBasePath('/api/devices/computer'), { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: row.id, digest: row.digest, approve }) })
      if (!response.ok) throw new Error(t('failed'))
      setMessage(t('queued'))
      await mutate()
    } catch { setMessage(t('failed')) }
    finally { setBusy(null) }
  }
  return <>
    <h1>{t('title')}</h1><p>{t('description')}</p>
    {(error || message) && <Alert><AlertDescription>{error ? t('failed') : message}</AlertDescription></Alert>}
    {data && !data.requests.length && <p>{t('empty')}</p>}
    {data?.requests.map(row => <Card key={row.id}>
      <CardHeader><CardTitle>{row.device}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p>{t('run', { id: row.runId })}</p>
        <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify({ target: row.target, call: row.call }, null, 2)}</pre>
        <p>{t('expires', { time: new Date(row.expiresAt).toLocaleTimeString() })}</p>
        <div className="flex gap-2"><Button disabled={Boolean(busy) || Date.parse(row.expiresAt) <= Date.now()} onClick={() => { void decide(row, true) }}>{t('approve')}</Button>
          <Button variant="outline" disabled={Boolean(busy)} onClick={() => { void decide(row, false) }}>{t('deny')}</Button></div>
      </CardContent>
    </Card>)}
  </>
}
