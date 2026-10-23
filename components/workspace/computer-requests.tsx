'use client'

import { useState } from 'react'
import useSWR from 'swr'
import Image from 'next/image'
import { useAgentCopy } from '@/hooks/use-agent-copy'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { withBasePath } from '@/lib/base-path'
import type { ComputerOperation } from '@/lib/cua/operation'

type Request = { id: string; operation: ComputerOperation; expiresAt: string }
export function ComputerRequests({ sessionId, loading, generation }: { sessionId: string | null; loading: boolean; generation: string }) {
  const copy = useAgentCopy()
  // Revalidate after a turn, not a timer. Only authenticated server-created
  // operations are renderable here; model-generated approval text does nothing.
  const { data, mutate } = useSWR<{ desktop: string; requests: Request[] }>(sessionId && !loading ? ['computer-requests', sessionId, generation] : null,
    async () => {
      const response = await fetch(withBasePath(`/api/agent/computer?sessionId=${sessionId}`), { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(copy.computerRequestFailed)
      return response.json()
    }, { revalidateOnFocus: true })
  if (!sessionId || !data?.requests.length) return null
  return <section aria-label={copy.computerApproval} className="flex flex-col gap-2">
    {data.requests.map(request => <ComputerRequest key={request.id} request={request} sessionId={sessionId} desktop={data.desktop} onDecided={() => { void mutate() }} />)}
  </section>
}
function ComputerRequest({ request, sessionId, desktop, onDecided }: { request: Request; sessionId: string; desktop: string; onDecided: () => void }) {
  const copy = useAgentCopy()
  const [busy, setBusy] = useState(false)
  const [decided, setDecided] = useState(false)
  const [image, setImage] = useState<string>()
  const [message, setMessage] = useState('')
  async function decide(approve: boolean) {
    if (busy || decided) return
    setBusy(true)
    setDecided(true)
    try {
      const response = await fetch(withBasePath('/api/agent/computer'), {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: request.id, sessionId, approve }),
      })
      if (!response.ok) throw new Error(copy.computerRequestFailed)
      const result = await response.json()
      setImage(result.result?.image)
      setMessage(approve ? copy.computerExecuted : copy.computerDenied)
    } catch { setMessage(copy.computerRequestFailed) }
    finally { setBusy(false); if (!approve) onDecided() }
  }
  return <Card size="sm">
    <CardHeader><CardTitle>{copy.computerApproval}</CardTitle></CardHeader>
    <CardContent className="flex flex-col gap-2">
      <p className="text-sm">{desktop}</p>
      <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(request.operation, null, 2)}</pre>
      <p className="text-xs text-muted-foreground">{copy.computerExactApproval}</p>
      {!decided && <div className="flex gap-2">
        <Button size="sm" disabled={busy || Date.parse(request.expiresAt) <= Date.now()} onClick={() => { void decide(true) }}>{copy.computerApproveOnce}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void decide(false) }}>{copy.computerDeny}</Button>
      </div>}
      {message && <Alert><AlertDescription>{message}</AlertDescription></Alert>}
      {image && <Image src={image} alt={copy.computerScreenshot} width={1600} height={1000} unoptimized className="h-auto w-full" />}
    </CardContent>
  </Card>
}
