'use client'

import { useRef, useState, type ReactNode } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { Ban, Check, CircleAlert, CircleX, ClipboardList, ExternalLink, FileCheck, GitMerge, GitPullRequest, MessageCircleQuestion, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { Stepper, StepperIndicator, StepperItem, StepperNav, StepperSeparator, StepperTitle } from '@/components/reui/stepper'
import { InlineLoadError } from '@/components/load-error'
import { useLiveKey } from '@/hooks/use-live-key'
import type { AcceptanceDetail } from '@/lib/factory/acceptance-view'
import { approveSpecConfirmed, approveSpecError, approveSpecErrorCode, approveSpecErrorKey, flowKey, flowTone, pullRequestLink, readFlow, type ApproveSpecFailure, type FactoryFlow, type FlowStage, type NeedsYouKind } from '@/lib/factory/flow-client'
import { RunErrorDetails } from './run-error-text'
import { pullNumberOf } from '@/lib/factory/artifact-review'
import { RequestError, request } from '@/lib/factory/browser-request'
import type { FactoryTask } from './factory-acceptance-pane'
import { navigate, openArtifact } from './workspace-navigation'
import * as acceptanceSlot from '@ui-slot/acceptance'
import type { AcceptanceAction, AcceptanceBlockProps } from '@/components/slots/acceptance-contract'

/** The task snapshot, as the Factory detail route returns it: v2 marks itself in `route`, and each attempt names its run. */
export type FactoryTaskDetail = AcceptanceDetail & { attempts?: { id: string; runId: string | null; stage: string }[] }

export const taskDetailKey = (taskId: string) => `/api/factory/tasks/${taskId}`
const tasksKey = (issueId: string) => `/api/factory/tasks?issueId=${encodeURIComponent(issueId)}`

/** One read per task, shared with the legacy acceptance row (same key). */
export function useFactoryTaskDetail(taskId: string) {
  return useSWR<FactoryTaskDetail>(taskDetailKey(taskId), request, { refreshInterval: 0 })
}

export const isFlowV2 = (detail: AcceptanceDetail | undefined) => detail?.task?.route?.flowVersion === 2

/** The card, producer header and acceptance pane share one SWR key and live invalidation. */
export function useFactoryFlow(taskId: string, detail: AcceptanceDetail | undefined, enabled = true) {
  const key = flowKey(taskId)
  const result = useSWR(enabled ? key : null, request, { refreshInterval: 0 })
  useLiveKey('factory_task', enabled ? taskId : null, enabled ? [key, taskDetailKey(taskId)] : [], detail?.liveWorkspaceId ?? null)
  return { ...result, flow: enabled ? readFlow(result.data) : null }
}

const NEEDS_YOU_ICONS: Record<NeedsYouKind, LucideIcon> = {
  spec_review: ClipboardList, question: MessageCircleQuestion, pr_review: GitPullRequest, blocked: CircleAlert, failed: CircleX,
}

/** R-87: the state is an icon, a colour and a word; a stage still at work spins. */
export function FactoryFlowBadge({ flow }: { flow: FactoryFlow }) {
  const t = useTranslations('FactoryFlow')
  const acceptance = useTranslations('FactoryAcceptance')
  const accepted = flow.stage === 'completed' && flow.completion === 'accepted'
  const Icon = flow.needsYou ? NEEDS_YOU_ICONS[flow.needsYou.kind] : flow.stage === 'completed' ? accepted ? Check : GitMerge : flow.stage === 'cancelled' ? Ban : null
  return <Badge variant="outline" tone={flowTone(flow)}>
    {Icon ? <Icon aria-hidden="true" /> : <Spinner />}
    {flow.needsYou ? t(`card.needsYou.${flow.needsYou.kind}`) : accepted ? acceptance('state.accepted') : t(`stages.${flow.stage}`)}
  </Badge>
}

/** The acceptance report's counts (Figma 947:1786): 4 项已验证 · 1 项未验证. */
export function CountBadges({ counts }: { counts: NonNullable<FactoryFlow['acceptance']>['counts'] }) {
  const t = useTranslations('FactoryFlow.card.counts')
  return <>
    {(counts.passed ?? 0) > 0 && <Badge variant="outline" tone="success"><Check aria-hidden="true" />{t('passed', { count: counts.passed ?? 0 })}</Badge>}
    {(counts.unverified ?? 0) > 0 && <Badge variant="outline" tone="warning"><TriangleAlert aria-hidden="true" />{t('unverified', { count: counts.unverified ?? 0 })}</Badge>}
    {(counts.failed ?? 0) > 0 && <Badge variant="outline" tone="destructive"><CircleX aria-hidden="true" />{t('failed', { count: counts.failed ?? 0 })}</Badge>}
  </>
}

/** The stages this task went through; skipped ones are not in the list (decision 2026-11-04-2200). Read-only reUI Stepper. */
function StageList({ flow }: { flow: FactoryFlow }) {
  const t = useTranslations('FactoryFlow')
  const acceptance = useTranslations('FactoryAcceptance')
  const active = flow.stages.indexOf(flow.stage) + 1
  const done = flow.stage === 'completed'
  return <Stepper value={active} role="list" aria-label={t('card.stageList')} indicators={{ completed: <Check aria-hidden="true" /> }}>
    {/* A phone can wrap the stages: there they go without connectors, so none is left pointing at nothing (UI audit task-24). */}
    <StepperNav className="flex-wrap gap-x-3 gap-y-2 sm:gap-x-0">
      {flow.stages.map((stage: FlowStage, index) => <StepperItem key={stage} step={index + 1} completed={done} role="listitem" aria-current={index + 1 === active ? 'step' : undefined} className="gap-1.5 not-last:flex-none">
        <StepperIndicator className="size-4">{index + 1 === active && !done ? <span className="size-1.5 rounded-full bg-current" /> : null}</StepperIndicator>
        <StepperTitle className="text-xs font-normal whitespace-nowrap text-muted-foreground data-[state=active]:font-medium data-[state=active]:text-foreground">{stage === 'completed' && flow.completion === 'accepted' ? acceptance('state.accepted') : t(`stages.${stage}`)}</StepperTitle>
        {index < flow.stages.length - 1 && <StepperSeparator className="mx-1 w-6 group-data-[orientation=horizontal]/stepper-nav:flex-none max-sm:hidden" />}
      </StepperItem>)}
    </StepperNav>
  </Stepper>
}

type Approval = { busy: boolean; error: (ApproveSpecFailure & { revision: number }) | null }

/**
 * A v2 Factory task on its task page (Figma 946:1560, 947:1786): one block
 * under the description with the stage, what it needs from the person and the
 * one action for it (R-89). Approving the spec POSTs `approve_spec` from this
 * browser session; a click keeps its eventId until the server answers it, so a
 * retry after a lost answer returns the same receipt instead of a second
 * approval. New data arrives through the task's live key, never a timer.
 */
export function FactoryFlowCard({ task, detail, onOpenThread, renderBlock }: { task: FactoryTask; detail: FactoryTaskDetail | undefined; onOpenThread: (runId: string) => void
  /** A layer's 验收 block (acceptance slot) for a task with a candidate: the caller adds the acceptance decision to what the flow says. */ renderBlock?: (block: AcceptanceBlockProps) => ReactNode }) {
  const t = useTranslations('FactoryFlow')
  const tAcceptance = useTranslations('FactoryAcceptance')
  const format = useFormatter()
  const now = useNow()
  const key = flowKey(task.id)
  const { flow, error, mutate, isValidating } = useFactoryFlow(task.id, detail)
  const { mutate: revalidate } = useSWRConfig()
  const [approval, setApproval] = useState<Approval>({ busy: false, error: null })
  const click = useRef<{ revision: number; eventId: string } | null>(null)
  const busy = useRef(false)

  if (!flow) return error ? <div className="w-full max-w-[26.25rem]"><InlineLoadError message={t('card.loadError')} retryLabel={t('card.retry')} onRetry={() => { if (!isValidating) void mutate() }} /></div> : null

  const specRunId = detail?.attempts?.find(attempt => attempt.id === detail.task?.attemptId)?.runId ?? null
  const pr = pullRequestLink(flow)
  const prNumber = pullNumberOf(pr)
  const kind = flow.needsYou?.kind
  const shownError = approval.error && (approval.error.kind === 'stale' || approval.error.revision === flow.revision) ? approval.error : null

  async function approve(current: FactoryFlow) {
    if (busy.current) return
    busy.current = true
    // One click is one event: a retry after an unconfirmed answer resends it.
    if (!click.current || click.current.revision !== current.revision) click.current = { revision: current.revision, eventId: crypto.randomUUID() }
    const { revision, eventId } = click.current
    setApproval({ busy: true, error: null })
    let failure: ApproveSpecFailure | null = null
    try {
      const receipt = await request(key, { operation: 'approve_spec', input: { binding: { taskId: task.id, revision }, eventId } })
      if (approveSpecConfirmed(receipt, task.id)) click.current = null
      else failure = approveSpecError(null, null)
    } catch (caught) {
      failure = caught instanceof RequestError
        ? approveSpecError(caught.code, caught.status, typeof caught.body.detail === 'string' ? caught.body.detail : null)
        : approveSpecError(null, null)
      // A refusal the server gave is final for this click; only an unanswered one is retried as itself.
      if (failure.kind !== 'unknown') click.current = null
    } finally {
      busy.current = false
      setApproval({ busy: false, error: failure ? { ...failure, revision } : null })
      await Promise.all([mutate(), revalidate(taskDetailKey(task.id)), revalidate(tasksKey(task.issueId))]).catch(() => undefined)
    }
  }

  const BlockSlot = acceptanceSlot.AcceptanceBlock ?? null
  if (BlockSlot) {
    const block = flowBlockProps({ task, flow, kind, specRunId, pr, prNumber, approval, shownError, words: { t, acceptance: tAcceptance }, approve: () => { void approve(flow) }, onOpenThread })
    return <>{renderBlock?.(block) ?? <BlockSlot {...block} />}</>
  }

  return <div className="w-full max-w-[40rem]">
    <Item variant="muted" data-stage={flow.stage} data-needs-you={kind}>
      <ItemContent className="min-w-0 basis-64 gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <FactoryFlowBadge flow={flow} />
          {/* How long it has waited for the person (decision 2026-11-04-2200, rule 7), beside the 需要你 kind it waits on. */}
          {flow.needsYou?.since && <time dateTime={flow.needsYou.since} className="text-xs text-muted-foreground tabular-nums">{format.relativeTime(new Date(flow.needsYou.since), now)}</time>}
          {flow.acceptance && <CountBadges counts={flow.acceptance.counts} />}
        </div>
        <StageList flow={flow} />
        {(kind === 'blocked' || kind === 'failed') && task.reason && <ItemDescription>{task.reason}</ItemDescription>}
        {shownError && <div role="alert" className="flex flex-col items-start">
          <p className="flex items-center gap-1.5 text-sm text-destructive-foreground"><CircleAlert aria-hidden="true" className="size-4 shrink-0" />{t(`card.approveError.${approveSpecErrorKey(shownError)}` as 'card.approveError.unknown')}</p>
          {approveSpecErrorCode(shownError) && <RunErrorDetails code={approveSpecErrorCode(shownError)!} />}
        </div>}
      </ItemContent>
      <ItemActions className="flex-wrap">
        {kind === 'spec_review' && <>
          {specRunId && <Button size="sm" variant="secondary" onClick={() => onOpenThread(specRunId)}>{t('card.openSpec')}</Button>}
          <Button size="sm" disabled={approval.busy} aria-busy={approval.busy} onClick={() => { void approve(flow) }}>
            {approval.busy ? <Spinner data-icon="inline-start" /> : shownError?.kind === 'unknown' ? <RefreshCw data-icon="inline-start" aria-hidden="true" /> : <Check data-icon="inline-start" aria-hidden="true" />}
            {shownError?.kind === 'unknown' ? t('card.retryApprove') : t('card.approveSpec')}
          </Button>
        </>}
        {kind === 'question' && flow.botId && <Button size="sm" onClick={() => navigate({ section: 'coordinator', bot: flow.botId, issue: null })}><MessageCircleQuestion data-icon="inline-start" aria-hidden="true" />{t('card.answer')}</Button>}
        {flow.acceptance
          // E2 (decision 2026-11-06-1615): a PR's report opens as the PR it reviews, 「查看 PR #1288」.
          ? <Button size="sm" onClick={() => openArtifact(flow.acceptance!.artifactId)}>{prNumber ? t('card.viewPullRequest', { number: prNumber }) : <><FileCheck data-icon="inline-start" aria-hidden="true" />{t('card.openAcceptance')}</>}</Button>
          : pr && kind === 'pr_review' && <Button size="sm" variant="secondary" nativeButton={false} render={<a href={pr} target="_blank" rel="noopener noreferrer" />}><ExternalLink data-icon="inline-start" aria-hidden="true" />{t('card.openPullRequest')}</Button>}
      </ItemActions>
    </Item>
  </div>
}

/** What the card says, as a layer's 验收 block (acceptance slot): the one thing to do now, or what goes on. */
function flowBlockProps({ task, flow, kind, specRunId, pr, prNumber, approval, shownError, words, approve, onOpenThread }: {
  task: FactoryTask; flow: FactoryFlow; kind: NeedsYouKind | undefined; specRunId: string | null; pr: string | null; prNumber: string | null
  approval: Approval; shownError: (ApproveSpecFailure & { revision: number }) | null
  words: { t: ReturnType<typeof useTranslations<'FactoryFlow'>>; acceptance: ReturnType<typeof useTranslations<'FactoryAcceptance'>> }
  approve: () => void; onOpenThread: (runId: string) => void
}): AcceptanceBlockProps {
  const { t, acceptance } = words
  const accepted = flow.stage === 'completed' && flow.completion === 'accepted'
  const running = !kind && (flow.stage === 'triage' || flow.stage === 'spec' || flow.stage === 'implement' || flow.stage === 'review')
  const counts = flow.acceptance?.counts
  // Who checked what (decision 2026-11-04-2200): the implementing agent verifies; review's verdict is advice.
  const checked = [
    counts?.passed ? t('block.passed', { count: counts.passed }) : null,
    counts?.unverified ? t('block.unverified', { count: counts.unverified }) : null,
    counts?.failed ? t('block.failed', { count: counts.failed }) : null,
  ].filter(Boolean).join(' · ')
  const verdict = flow.review?.currentCandidateReviewed ? flow.review.verdict : null
  const review = verdict ? t('block.review', { verdict: verdict === 'passed' ? acceptance('reviewPassed') : verdict === 'changes_requested' ? acceptance('reviewFailed') : t('block.needsJudgment') }) : null
  const summary = [checked ? t('block.checked', { counts: checked }) : null, review].filter(Boolean).join(' · ') || null
  const links: AcceptanceAction[] = []
  if (kind === 'spec_review' && specRunId) links.push({ id: 'open-spec', label: t('card.openSpec'), onSelect: () => onOpenThread(specRunId) })
  if (flow.acceptance) { const artifactId = flow.acceptance.artifactId; links.push({ id: 'open-report', label: t('block.openReport'), onSelect: () => openArtifact(artifactId) }) }
  else if (pr && kind === 'pr_review') links.push({ id: 'open-pr', label: t('card.openPullRequest'), href: pr })
  const botId = flow.botId
  const primary: AcceptanceAction | null = kind === 'spec_review'
    ? { id: 'approve-spec', label: shownError?.kind === 'unknown' ? t('card.retryApprove') : t('card.approveSpec'), busy: approval.busy, disabled: approval.busy, onSelect: approve }
    : kind === 'question' && botId ? { id: 'answer', label: t('card.answer'), onSelect: () => navigate({ section: 'coordinator', bot: botId, issue: null }) } : null
  return {
    taskId: task.id,
    title: task.isSkillCandidate ? acceptance('skillTitle') : acceptance('title'),
    subject: prNumber && pr ? { label: `PR #${prNumber}`, href: pr } : null,
    state: { label: flow.needsYou ? t(`card.needsYou.${flow.needsYou.kind}`) : accepted ? acceptance('state.accepted') : t(`stages.${flow.stage}`), tone: flowTone(flow) },
    status: running ? t('block.running', { stage: t(`stages.${flow.stage}`) }) : null,
    summary: running ? null : summary,
    problem: (kind === 'blocked' || kind === 'failed') && task.reason ? { text: task.reason } : null,
    primary,
    links,
    notices: shownError ? [{ id: 'approve-error', text: t(`card.approveError.${approveSpecErrorKey(shownError)}` as 'card.approveError.unknown'), detail: approveSpecErrorCode(shownError) ?? undefined }] : [],
  }
}
