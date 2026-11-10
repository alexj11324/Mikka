'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import useSWR from 'swr'
import { useLiveKey } from '@/hooks/use-live-key'
import { useTranslations } from 'next-intl'
import { ChevronRight, CircleAlert, ClipboardCheck, RefreshCw, X } from 'lucide-react'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { acceptanceStateKey } from '@/lib/factory/acceptance-state'
import { visibleAcceptance } from '@/lib/factory/acceptance-view'
import { acceptanceTone as tone, FactoryAcceptancePane, request, useAcceptance, type ArtifactReviewSlots, type FactoryTask } from './factory-acceptance-pane'
import * as acceptanceSlot from '@ui-slot/acceptance'
import { FactoryFlowBadge, FactoryFlowCard, isFlowV2, useFactoryTaskDetail } from './factory-flow'
import { flowKey, readFlow } from '@/lib/factory/flow-client'
import { InlineLoadError } from '@/components/load-error'
import { ArtifactReportLead } from './acceptance-report'

export type { FactoryTask } from './factory-acceptance-pane'

const tasksKey = (issueId: string) => `/api/factory/tasks?issueId=${encodeURIComponent(issueId)}`

/** The issue's acceptance tasks, shared by the issue page list and every thread header. */
export function useAcceptanceTasks(issueId: string | null) {
  // A thread with no task has no acceptance ledger.
  const result = useSWR<{ tasks: FactoryTask[]; liveWorkspaceId?: string | null }>(issueId ? tasksKey(issueId) : null, request, { refreshInterval: 0 })
  useLiveKey('factory_issue', issueId, issueId ? [tasksKey(issueId)] : [], result.data?.liveWorkspaceId ?? null)
  // A 200 body that is not `{ tasks: [...] }` (an HTML fallback parsed as `{}`,
  // or an API that omits `tasks`) must read as no tasks, not crash the page.
  const allTasks = Array.isArray(result.data?.tasks) ? result.data.tasks : []
  return { ...result, tasks: allTasks.filter(visibleAcceptance), allTasks }
}

/** The acceptance task whose candidate this thread produced, if any: its header then offers 验收 (frame 06). */
export function useThreadAcceptance(issueId: string | null, runId: string) {
  return useAcceptanceTasks(issueId).tasks.find(task => task.candidateRunId === runId)
}

/** The v2 report's decision uses the existing pane actions, bound to its current candidate and version. */
function ArtifactDecision({ task, artifactId, version, latestVersion, review }: { task: FactoryTask; artifactId: string; version: number; latestVersion: number; review?: Omit<ArtifactReviewSlots, 'artifactId'> }) {
  const t = useTranslations('FactoryAcceptance')
  const { data: detail } = useFactoryTaskDetail(task.id)
  const key = flowKey(task.id)
  const { data, error, mutate, isValidating } = useSWR(key, request)
  useLiveKey('factory_task', task.id, [key], detail?.liveWorkspaceId ?? null)
  const flow = readFlow(data), report = flow?.acceptance
  if (error) return <div className="shrink-0 px-4 pb-3"><InlineLoadError message={t('loadError')} retryLabel={t('retry')} onRetry={() => { if (!isValidating) void mutate() }} /></div>
  // The Artifact keeps its initial runId across repairs. Its current report,
  // not that historical run, binds this version to the candidate being judged.
  if (!flow || !report || flow.id !== task.id || flow.issueId !== task.issueId || flow.revision !== task.revision ||
      report.artifactId !== artifactId || version !== latestVersion || report.version !== version ||
      report.candidateId !== task.candidateId || report.runId !== task.candidateRunId) return null
  return <FactoryAcceptancePane key={`${task.id}:${report.candidateId}:${version}`} task={task}
    artifactBinding={{ candidateId: report.candidateId, revision: flow.revision }} artifact={review && { ...review, artifactId }} />
}

/** Ordinary artifacts have no task hint; every hinted task still goes through the normal authorized list and flow. */
export function FactoryArtifactAcceptance({ taskId, issueId, review, ...view }: { taskId: string; issueId: string; artifactId: string; version: number; latestVersion: number; review?: Omit<ArtifactReviewSlots, 'artifactId'> }) {
  const { allTasks, error, isValidating, mutate } = useAcceptanceTasks(issueId)
  const [banner, setBanner] = useState<HTMLElement | null>(null)
  const task = allTasks.find(row => row.id === taskId)
  if (error) return <div className="shrink-0 px-4 pb-3"><FactoryListError retrying={isValidating} onRetry={() => { if (!isValidating) void mutate() }} /></div>
  if (!task) return null
  // The report lead is read-only and drawn in every state of the PR, also while a fix run or failed checks
  // unbind the decision below (P3, P7b); the decision's actions stay bound to the current candidate.
  return <>
    {review?.slots.lead && view.version === view.latestVersion && createPortal(<ArtifactReportLead task={task} artifactId={view.artifactId} onBannerSlot={setBanner} actions={review.slots.actions} />, review.slots.lead)}
    <ArtifactDecision task={task} {...view} review={review && { ...review, slots: { ...review.slots, banner } }} />
  </>
}

/** The state chip next to a thread's name (等你验收, 已批准 …), from the same ledger as the pane. */
export function AcceptanceStateBadge({ task }: { task: FactoryTask }) {
  const t = useTranslations('FactoryAcceptance')
  const { derived, check, detailLoaded, v2, flow } = useAcceptance(task)
  if (!detailLoaded) return null
  if (v2) return flow ? <FactoryFlowBadge flow={flow} /> : null
  if (check) return <Badge variant="outline" tone={check.status === 'failed' || check.status === 'blocked' ? 'destructive' : check.status === 'pending' ? 'warning' : 'info'} className="shrink-0">{check.status === 'blocked' && <CircleAlert aria-hidden="true" />}{t(`checkState.${check.stage}.${check.status}`)}</Badge>
  return derived ? <Badge variant="outline" tone={tone(derived.state)} className="shrink-0">{derived.refusal ? t('cannotMerge') : t(acceptanceStateKey(derived.state, task.isSkillCandidate))}</Badge> : null
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
  const { derived, check } = useAcceptance(task)
  const state = derived?.state
  const Slot = acceptanceSlot.AcceptanceRow ?? null
  // data-slot="item" keeps the 验收 heading over a layer's row, as over the open-source Item.
  if (Slot) return <div data-slot="item" className="w-full min-w-0"><Slot taskId={task.id} title={task.isSkillCandidate ? t('skillTitle') : t('title')} reason={check?.status !== 'blocked' ? task.reason || null : null} onOpen={onOpen}
    state={check ? { label: t(`checkState.${check.stage}.${check.status}`), tone: check.status === 'failed' || check.status === 'blocked' ? 'destructive' : check.status === 'pending' ? 'warning' : 'info' }
      : state ? { label: derived?.refusal ? t('cannotMerge') : t(acceptanceStateKey(state, task.isSkillCandidate)), tone: tone(state) } : null} /></div>
  return <div className="w-full max-w-[26.25rem]">
    <Item variant="muted">
      <ItemMedia variant="icon"><ClipboardCheck aria-hidden="true" /></ItemMedia>
      <ItemContent>
        <ItemTitle>{task.isSkillCandidate ? t('skillTitle') : t('title')}</ItemTitle>
        {check?.status !== 'blocked' && <ItemDescription>{task.reason}</ItemDescription>}
      </ItemContent>
      <ItemActions>
        {check ? <Badge variant="outline" tone={check.status === 'failed' || check.status === 'blocked' ? 'destructive' : check.status === 'pending' ? 'warning' : 'info'}>{check.status === 'blocked' && <CircleAlert aria-hidden="true" />}{t(`checkState.${check.stage}.${check.status}`)}</Badge>
          : state && <Badge variant="outline" tone={tone(state)}>{derived?.refusal ? t('cannotMerge') : t(acceptanceStateKey(state, task.isSkillCandidate))}</Badge>}
        <Button variant="ghost" size="icon" aria-label={task.isSkillCandidate ? t('skillTitle') : t('title')} onClick={onOpen}><ChevronRight data-icon="inline-start" /></Button>
      </ItemActions>
    </Item>
  </div>
}

/** A v2 task's block (decision 2026-11-04-2200); nothing until its snapshot says it follows that flow. */
function FactoryFlowEntry({ task, onOpenThread }: { task: FactoryTask; onOpenThread?: (runId: string) => void }) {
  const { data: detail } = useFactoryTaskDetail(task.id)
  return isFlowV2(detail) ? <FactoryFlowCard task={task} detail={detail} onOpenThread={runId => onOpenThread?.(runId)} /> : null
}

/** An older task's acceptance row; a v2 task has its own block instead. */
function LegacyAcceptanceEntry({ task, onOpen }: { task: FactoryTask; onOpen: () => void }) {
  const { data: detail } = useFactoryTaskDetail(task.id)
  return !detail || isFlowV2(detail) ? null : <FactoryAcceptanceRow task={task} onOpen={onOpen} />
}

/**
 * The issue page's Factory block, under the description (R-89). A v2 task
 * shows its stage, what it needs from you and the one action for it. An older
 * task keeps its acceptance row while it waits for you; opening one opens the
 * thread that produced the candidate on its 验收 tab (Figma 357:4750, frame
 * 06), or the acceptance alone when no thread is known.
 */
export function FactoryAcceptance({ issueId, onOpen, onOpenThread }: { issueId: string; onOpen?: (task: FactoryTask) => void; onOpenThread?: (runId: string) => void }) {
  const t = useTranslations('FactoryAcceptance')
  const { data, error, isLoading, mutate, tasks, allTasks } = useAcceptanceTasks(issueId)
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
  return <>
    {allTasks.map(task => <FactoryFlowEntry key={task.id} task={task} onOpenThread={onOpenThread} />)}
    {/* A heading over rows that all turned out to be v2 would stand alone, so it hides with them. */}
    {tasks.length > 0 && <section className="flex flex-col gap-2 [&:not(:has([data-slot=item]))]:hidden">
      {heading}
      {tasks.map(task => <LegacyAcceptanceEntry key={task.id} task={task} onOpen={() => onOpen?.(task)} />)}
    </section>}
  </>
}

/** Acceptance for a task with no known thread: the same pane under its own header. */
export function FactoryAcceptancePanel({ task, onClose, onOpenThread }: { task: FactoryTask; onClose: () => void; onOpenThread?: (runId: string) => void }) {
  const t = useTranslations('FactoryAcceptance')
  // A recovered execution gains its candidate after this panel opens. Follow
  // the same owned task through checks and approval without retaining old props.
  const current = useAcceptanceTasks(task.issueId).allTasks.find(row => row.id === task.id) ?? task
  const title = current.isSkillCandidate ? t('skillTitle') : t('title')
  // A layer's pane draws its own header with ✕ (acceptance slot).
  if (acceptanceSlot.AcceptancePane) return <section aria-label={title} className="flex h-full min-h-0 flex-col">
    <FactoryAcceptancePane task={current} onOpenThread={onOpenThread} onClose={onClose} />
  </section>
  return <section aria-label={title} className="flex h-full min-h-0 flex-col">
    <header className="flex h-12 shrink-0 items-center gap-2 px-4">
      <ClipboardCheck aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
      <AcceptanceStateBadge task={current} />
      <span className="flex-1" />
      <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}><X data-icon="inline-start" /></Button>
    </header>
    <FactoryAcceptancePane task={current} onOpenThread={onOpenThread} />
  </section>
}
