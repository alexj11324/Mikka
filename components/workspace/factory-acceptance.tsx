'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ChevronRight, ClipboardCheck, RefreshCw, X } from 'lucide-react'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { acceptanceStateKey, type AcceptanceState } from '@/lib/factory/acceptance-state'
import { FactoryAcceptancePane, request, useAcceptance, type FactoryTask } from './factory-acceptance-pane'

export type { FactoryTask } from './factory-acceptance-pane'

const tone = (state: AcceptanceState) => state === 'live' ? 'success' : state === 'pending' ? 'warning' : state === 'failed' ? 'destructive' : state === 'revoked' || state === 'expired' || state === 'invalidated' ? 'neutral' : 'info'

/** A task the person can accept or follow: waiting for approval, or being published. */
const accepting = (task: FactoryTask) => (task.stage === 'approval' && ['pending', 'waiting'].includes(task.status)) || task.stage === 'publish'

const tasksKey = (issueId: string) => `/api/factory/tasks?issueId=${encodeURIComponent(issueId)}`

/** The issue's acceptance tasks, shared by the issue page list and every thread header. */
function useAcceptanceTasks(issueId: string, refreshInterval = 15000) {
  const result = useSWR<{ tasks: FactoryTask[] }>(tasksKey(issueId), request, { refreshInterval })
  // A 200 body that is not `{ tasks: [...] }` (an HTML fallback parsed as `{}`,
  // or an API that omits `tasks`) must read as no tasks, not crash the page.
  const tasks = (Array.isArray(result.data?.tasks) ? result.data.tasks : []).filter(accepting)
  return { ...result, tasks }
}

/** The acceptance task whose candidate this thread produced, if any: its header then offers 验收 (frame 06). */
export function useThreadAcceptance(issueId: string, runId: string) {
  return useAcceptanceTasks(issueId).tasks.find(task => task.candidateRunId === runId)
}

/** The state chip next to a thread's name (等你验收, 已批准 …), from the same ledger as the pane. */
export function AcceptanceStateBadge({ task }: { task: FactoryTask }) {
  const t = useTranslations('FactoryAcceptance')
  const state = useAcceptance(task).derived?.state
  return state ? <Badge variant="outline" tone={tone(state)} className="shrink-0">{t(acceptanceStateKey(state, task.isSkillCandidate))}</Badge> : null
}

/** The list's load failure. Retry is busy while refetching and cannot fire twice. */
export function FactoryListError({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  const t = useTranslations('FactoryAcceptance')
  return <Alert>
    <AlertTitle>{t('listError')}</AlertTitle>
    <AlertAction><Button size="sm" disabled={retrying} aria-busy={retrying} onClick={onRetry}>{retrying ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" aria-hidden="true" />}{t('retry')}</Button></AlertAction>
  </Alert>
}

function FactoryAcceptanceRow({ task, onOpen }: { task: FactoryTask; onOpen: () => void }) {
  const t = useTranslations('FactoryAcceptance')
  const state = useAcceptance(task).derived?.state
  return <div className="w-full max-w-[26.25rem]">
    <Item variant="muted">
      <ItemMedia variant="icon"><ClipboardCheck aria-hidden="true" /></ItemMedia>
      <ItemContent>
        <ItemTitle>{task.isSkillCandidate ? t('skillTitle') : t('title')}</ItemTitle>
        <ItemDescription>{task.reason}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {state && <Badge variant="outline" tone={tone(state)}>{t(acceptanceStateKey(state, task.isSkillCandidate))}</Badge>}
        <Button variant="ghost" size="icon" aria-label={task.isSkillCandidate ? t('skillTitle') : t('title')} onClick={onOpen}><ChevronRight data-icon="inline-start" /></Button>
      </ItemActions>
    </Item>
  </div>
}

/**
 * The issue page's way into acceptance: one row per task waiting for you.
 * Opening one opens the thread that produced the candidate on its 验收 tab
 * (Figma 357:4750, frame 06), or the acceptance alone when no thread is known.
 */
export function FactoryAcceptance({ issueId, onOpen }: { issueId: string; onOpen?: (task: FactoryTask) => void }) {
  const t = useTranslations('FactoryAcceptance')
  const { data, error, isLoading, mutate, tasks } = useAcceptanceTasks(issueId)
  const [retrying, setRetrying] = useState(false)
  const retryingRef = useRef(false)
  const focusAfterRetry = useRef(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const failed = Boolean(error && !data)
  useEffect(() => {
    if (!focusAfterRetry.current || failed || isLoading) return
    focusAfterRetry.current = false
    headingRef.current?.focus()
  }, [failed, isLoading, data])
  async function retry() {
    if (retryingRef.current) return
    retryingRef.current = true; setRetrying(true)
    // Armed before the refetch: SWR can render the new data before mutate() resolves.
    focusAfterRetry.current = true
    try { if (!await mutate()) focusAfterRetry.current = false } catch { focusAfterRetry.current = false /* the alert stays */ }
    finally { retryingRef.current = false; setRetrying(false) }
  }
  const heading = <h3 ref={headingRef} tabIndex={-1} className="text-sm font-medium outline-none">{t('title')}</h3>
  if (failed) return <section className="flex flex-col gap-2">
    {heading}
    <div className="min-h-16 w-full max-w-[26.25rem]"><FactoryListError retrying={retrying} onRetry={() => { void retry() }} /></div>
  </section>
  if (isLoading) return <section aria-busy="true" className="flex flex-col gap-2">
    {heading}
    <div className="h-16 w-full max-w-[26.25rem] overflow-hidden rounded-xl"><Skeleton data-testid="factory-acceptance-loading" className="size-full" /></div>
  </section>
  if (!tasks.length) return null
  return <section className="flex flex-col gap-2">
    {heading}
    {tasks.map(task => <FactoryAcceptanceRow key={task.id} task={task} onOpen={() => onOpen?.(task)} />)}
  </section>
}

/** Acceptance for a task with no known thread: the same pane under its own header. */
export function FactoryAcceptancePanel({ task, onClose, onOpenThread }: { task: FactoryTask; onClose: () => void; onOpenThread?: (runId: string) => void }) {
  const t = useTranslations('FactoryAcceptance')
  const title = task.isSkillCandidate ? t('skillTitle') : t('title')
  return <section aria-label={title} className="flex h-full min-h-0 flex-col">
    <header className="flex h-12 shrink-0 items-center gap-2 px-4">
      <ClipboardCheck aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
      <AcceptanceStateBadge task={task} />
      <span className="flex-1" />
      <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}><X data-icon="inline-start" /></Button>
    </header>
    <FactoryAcceptancePane task={task} onOpenThread={onOpenThread} />
  </section>
}
