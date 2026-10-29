'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import { useTranslations } from 'next-intl'
import { CalendarClock, FileText, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { authClient } from '@/lib/auth-client'
import { useActionError } from '@/lib/use-action-error'
import { ApprovedWriteClientError, decideApprovedWrite, loadApprovedWriteAvailability, loadUnresolvedWrites, readApprovedWrite, type ApprovedWriteItem } from '@/lib/operations/write-client'
import type { WritePage } from '@/lib/operations/write-discovery'

const text = (value: unknown) => typeof value === 'string' ? value : null
const eventTime = (value: unknown) => value && typeof value === 'object' ? text((value as Record<string, unknown>).dateTime ?? (value as Record<string, unknown>).date) : null

function WriteCard({ item, scope, uncertain, busy, onDecide, onSettled, onRecover }: {
  item: ApprovedWriteItem; scope: string; uncertain: boolean; busy: boolean
  onDecide: (item: ApprovedWriteItem, approve: boolean) => void; onSettled: (id: string) => void; onRecover: (id: string) => void
}) {
  const t = useTranslations('Coordinator.pendingActions')
  const checking = uncertain || item.status === 'running'
  const { data: current, error: readError, isValidating } = useSWR(checking ? ['approved-write-result', scope, item.action, item.id] : null, () => readApprovedWrite(item.action, item.id), { refreshInterval: 10000, shouldRetryOnError: false })
  const settled = current?.status === 'done' || current?.status === 'declined' || item.status === 'done' || item.status === 'declined'
  useEffect(() => { if (settled) onSettled(item.id) }, [settled, item.id, onSettled])
  if (settled) return null
  const view = current ?? item
  const attention = view.status === 'attention'
  const input = attention ? {} : view.input
  const context = attention ? null : view.approvalContext
  const running = checking || view.status === 'running'
  const expired = !attention && Date.parse(view.approvalExpiresAt) <= Date.now()
  const recoverable = uncertain && !readError && !isValidating && current?.id === item.id && current.action === item.action && current.status === 'pending' && Date.parse(current.approvalExpiresAt) > Date.now()
  const calendar = item.action === 'cancel_calendar_event'
  const slack = item.action === 'send_slack_message'
  const Icon = calendar ? CalendarClock : slack ? MessageSquare : FileText
  const target = calendar ? input.event_id : slack ? input.channel : input.page_id
  const targetName = calendar ? text(context?.summary) : slack ? text(context?.name) ?? text(context?.user) : null
  return <li className="flex flex-col gap-3 rounded-[14px] bg-muted/60 px-4 py-3">
    <p className="flex items-center gap-2 text-sm font-medium"><Icon className="size-4" />{t(item.action)}</p>
    {!attention && <dl className="flex flex-col gap-1">
      <div className="flex gap-3 text-xs"><dt className="w-14 shrink-0 text-muted-foreground">{t('account')}</dt><dd className="min-w-0 break-words">{view.account.accountId}</dd></div>
      <div className="flex gap-3 text-xs"><dt className="w-14 shrink-0 text-muted-foreground">{t(calendar ? 'eventTitle' : slack ? 'channel' : 'page')}</dt><dd className="min-w-0 break-words">{[targetName, text(target)].filter(Boolean).join(' · ')}</dd></div>
      {calendar && (eventTime(context?.start) || eventTime(context?.end)) && <div className="flex gap-3 text-xs"><dt className="w-14 shrink-0 text-muted-foreground">{t('time')}</dt><dd className="min-w-0 break-words">{[eventTime(context?.start), eventTime(context?.end)].filter(Boolean).join(' – ')}</dd></div>}
      {calendar && <div className="flex gap-3 text-xs"><dt className="w-14 shrink-0 text-muted-foreground">{t('notify')}</dt><dd className="min-w-0 break-words">{t(input.send_updates === 'all' ? 'notifyAll' : input.send_updates === 'externalOnly' ? 'notifyExternal' : 'notifyNo')}</dd></div>}
    </dl>}
    {typeof input.text === 'string' && <p className="max-h-48 overflow-y-auto rounded-lg bg-background/70 px-3 py-2 text-sm whitespace-pre-wrap">{input.text}</p>}
    {(running || attention || expired) && <p role="status" className="text-xs text-muted-foreground">{t(running ? 'resultUnconfirmed' : attention ? 'needsReview' : 'expired')}</p>}
    {recoverable && <div className="flex justify-end"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { if (Date.parse(current.approvalExpiresAt) > Date.now()) onRecover(item.id) }}>{t('resumeApproval')}</Button></div>}
    {!running && <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onDecide(item, false)}>{t('decline')}</Button>
      {!attention && <Button type="button" size="sm" disabled={busy || expired} onClick={() => onDecide(item, true)}>{busy ? <Spinner /> : null}{t(calendar ? 'approveDelete' : slack ? 'approveSend' : 'approveAppend')}</Button>}
    </div>}
  </li>
}

/** New ledger-backed proposals use their own endpoint; never the legacy decider. */
export function ApprovedWriteActions() {
  const t = useTranslations('Coordinator.pendingActions')
  const actionError = useActionError()
  const { data: session, isPending } = authClient.useSession()
  const viewer = !isPending ? session?.user.id : undefined
  const scope = viewer && session ? `${viewer}:${session.session.id}` : ''
  const liveScope = useRef(scope); liveScope.current = scope
  const busyRef = useRef<{ scope: string; id: string } | null>(null)
  const [busy, setBusy] = useState<{ scope: string; id: string } | null>(null)
  const [uncertain, setUncertain] = useState<{ scope: string; items: Record<string, ApprovedWriteItem> }>({ scope: '', items: {} })
  const { data: available, error: availabilityError, mutate: refreshAvailability } = useSWR('approved-write-availability', loadApprovedWriteAvailability, { refreshInterval: 10000, shouldRetryOnError: false })
  const enabled = available === true && !availabilityError
  const { data, error, mutate, size, setSize, isValidating } = useSWRInfinite<WritePage>(
    (_index, previous) => !enabled || !scope || previous && !previous.nextCursor ? null : ['approved-writes', viewer, scope, previous?.nextCursor ?? ''],
    ([, owner, , cursor]: [string, string, string, string]) => loadUnresolvedWrites(owner, cursor || undefined),
    { refreshInterval: 10000, shouldRetryOnError: false, revalidateAll: true },
  )
  const clearUncertain = useCallback((id: string) => {
    if (liveScope.current !== scope) return
    setUncertain(previous => previous.scope === scope && previous.items[id] ? { scope, items: Object.fromEntries(Object.entries(previous.items).filter(([key]) => key !== id)) } : previous)
    void mutate()
  }, [scope, mutate])
  if (!scope) return null
  if (!enabled) return availabilityError ? <li className="flex items-center justify-between gap-3 px-4 py-2"><p role="alert" className="text-xs">{t('approvalLoadFailed')}</p><Button type="button" variant="ghost" size="sm" onClick={() => { void refreshAvailability() }}>{t('refresh')}</Button></li> : null
  const items = new Map<string, ApprovedWriteItem>((error ? [] : data?.flatMap(page => page.items) ?? []).map(item => [item.id, item]))
  if (uncertain.scope === scope) for (const item of Object.values(uncertain.items)) items.set(item.id, item)

  async function decide(item: ApprovedWriteItem, approve: boolean) {
    if (busyRef.current?.scope === scope) return
    const requestScope = scope
    const operation = { scope: requestScope, id: item.id }
    busyRef.current = operation; setBusy(operation)
    const retainUnknown = () => setUncertain(previous => ({ scope: requestScope, items: { ...(previous.scope === requestScope ? previous.items : {}), [item.id]: item } }))
    try {
      const status = await decideApprovedWrite(item.action, item.id, approve)
      if (liveScope.current !== requestScope) return
      if (status === 'running') retainUnknown()
      else { if (status === 'done') toast.success(t('completed')); await mutate() }
    } catch (failure) {
      if (liveScope.current !== requestScope) return
      if (failure instanceof ApprovedWriteClientError && failure.uncertain) retainUnknown()
      toast.error(actionError())
      void mutate()
    } finally { if (busyRef.current === operation) { busyRef.current = null; setBusy(null) } }
  }

  return <>
    {[...items.values()].map(item => <WriteCard key={`${scope}:${item.id}`} item={item} scope={scope} uncertain={uncertain.scope === scope && Boolean(uncertain.items[item.id])} busy={busy?.scope === scope} onDecide={(item, approve) => { void decide(item, approve) }} onSettled={clearUncertain} onRecover={clearUncertain} />)}
    {error && <li className="flex items-center justify-between gap-3 px-4 py-2"><p role="alert" className="text-xs">{t('approvalLoadFailed')}</p><Button type="button" variant="ghost" size="sm" onClick={() => { void mutate() }}>{t('refresh')}</Button></li>}
    {data?.at(-1)?.nextCursor && <li><Button type="button" variant="ghost" size="sm" disabled={isValidating} onClick={() => { void setSize(size + 1) }}>{t('more')}</Button></li>}
  </>
}
