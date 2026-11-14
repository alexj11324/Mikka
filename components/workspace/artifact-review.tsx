'use client'

import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { useRunArtifacts } from '@/hooks/use-thread-run-reads'
import { ArtifactIcon } from '@/components/icons/artifact-icon'
import { ArtifactCard, ArtifactKindIcon } from '@/components/artifacts/artifact-card'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLiveKey } from '@/hooks/use-live-key'
import { flowMergeAcceptance, mergeAcceptance, type AcceptanceMerge } from '@/lib/factory/acceptance-state'
import { artifactReviewDot, artifactReviewKind, pullNumberOf, type ArtifactReviewKind } from '@/lib/factory/artifact-review'
import { request } from '@/lib/factory/browser-request'
import type { ArtifactSummary } from '@/lib/artifacts/types'
import { cn } from '@/lib/utils'
import { isFlowV2, taskDetailKey, useFactoryFlow, type FactoryTaskDetail } from './factory-flow'
import { openArtifact } from './workspace-navigation'

const ledgerKey = (taskId: string) => `/api/factory/tasks/${taskId}/approval?view=ledger`

/**
 * Where a PR's acceptance report stands, from the reads the acceptance pane
 * already shares (task detail, flow, ledger: one request each per task, then
 * the task's live key). Nothing reads without a task.
 */
export function useArtifactReview(taskId: string | null | undefined, { hasArtifact, runSucceeded }: { hasArtifact: boolean; runSucceeded: boolean }) {
  const id = taskId ?? null
  const { data: detail } = useSWR<FactoryTaskDetail>(id ? taskDetailKey(id) : null, request, { refreshInterval: 0 })
  const v2 = isFlowV2(detail)
  const { flow } = useFactoryFlow(id ?? '', detail, Boolean(id) && v2)
  const { data: ledger } = useSWR<{ merges?: AcceptanceMerge[]; rejections?: { note: string | null; createdAt: string }[] }>(id ? ledgerKey(id) : null, request, { refreshInterval: 0 })
  useLiveKey('factory_task', id, id ? [taskDetailKey(id), ledgerKey(id)] : [], detail?.liveWorkspaceId ?? null)
  const merges = Array.isArray(ledger?.merges) ? ledger.merges : []
  const task = detail?.task
  const merge = !id || !task ? null : v2 ? flowMergeAcceptance({ flow, candidateId: task.candidateId, merges })
    : mergeAcceptance({ stage: task.stage, status: task.status, candidateId: task.candidateId, merges })
  const kind = artifactReviewKind({ hasArtifact, runSucceeded, flow: v2 ? flow : null, merge: v2 && !flow ? null : merge })
  const pullRequest = detail?.delivery?.pullRequest ?? null
  return { kind, detail, flow, ledger, merge, pullRequest, number: pullNumberOf(pullRequest?.url) }
}

/** 「Artifact · PR #1288 待你审」 in the tooltip; 「Artifact · 待你审」 under a card. */
export function useArtifactReviewText() {
  const t = useTranslations('ArtifactReview')
  return {
    tooltip: (kind: ArtifactReviewKind, number: string | null) => kind === 'none' || kind === 'preparing' || kind === 'ready' ? t(`tooltip.${kind}`)
      : number ? t('tooltipPr', { number, state: t(`state.${kind}`) }) : t('tooltipState', { state: t(`state.${kind}`) }),
    line: (kind: ArtifactReviewKind) => t('tooltipState', { state: t(`state.${kind === 'none' || kind === 'preparing' || kind === 'ready' ? 'review' : kind}`) }),
    title: (number: string, title: string) => t('cardTitle', { number, title }),
  }
}

/** The status dot on the corner of the Artifact icon (E1). */
export function ArtifactReviewDot({ kind }: { kind: ArtifactReviewKind }) {
  const dot = artifactReviewDot(kind)
  return dot ? <span aria-hidden="true" data-slot="artifact-review-dot" data-tone={dot} className={cn('absolute top-1 right-1 size-2 rounded-full ring-2 ring-background',
    dot === 'warning' && 'bg-warning', dot === 'neutral' && 'bg-muted-foreground', dot === 'merged' && 'bg-github-pr-merged', dot === 'destructive' && 'bg-destructive')} /> : null
}

/**
 * The thread header's Artifact button (E1, decision 2026-11-06-1615): always
 * there, left of stop, an icon whose words live in its tooltip. Off until the
 * thread hands something over; then one Artifact opens in the window and
 * several open the list first. A dot on its corner says where the PR stands.
 */
export function ThreadArtifactButton({ runId, status, taskId }: { runId: string; status: string; /** The acceptance task this thread produced, when the panel knows it. */ taskId?: string | null }) {
  const text = useArtifactReviewText()
  const { data } = useRunArtifacts(runId, status)
  const mine = data ?? []
  const report = mine.find(item => item.acceptanceTaskId)
  const review = useArtifactReview(report?.acceptanceTaskId ?? taskId, { hasArtifact: mine.length > 0, runSucceeded: status === 'succeeded' })
  const label = text.tooltip(review.kind, review.number)
  const waiting = review.kind === 'review'
  const className = cn('relative shrink-0 text-muted-foreground', waiting && 'bg-muted text-foreground')
  const icon = <><ArtifactIcon data-icon="inline-start" /><ArtifactReviewDot kind={review.kind} /></>
  if (mine.length > 1) return <DropdownMenu>
    <Tooltip><TooltipTrigger render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" data-slot="thread-artifact" data-state={review.kind} aria-label={label} className={className} />} />}>{icon}</TooltipTrigger><TooltipContent side="bottom">{label}</TooltipContent></Tooltip>
    <DropdownMenuContent align="end" className="w-64">
      <DropdownMenuGroup>{mine.map(item => <DropdownMenuItem key={item.id} onClick={() => openArtifact(item.id)}><ArtifactKindIcon kind={item.kind} /><span className="truncate">{item.title}</span></DropdownMenuItem>)}</DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
  // Off, with the reason in its tooltip, until there is an Artifact to open.
  return <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" data-slot="thread-artifact" data-state={review.kind} aria-label={label} disabled={!mine.length} focusableWhenDisabled className={className}
    onClick={() => { if (mine[0]) openArtifact(mine[0].id) }} />}>{icon}</TooltipTrigger><TooltipContent side="bottom">{label}</TooltipContent></Tooltip>
}

/**
 * An Artifact's card in a chat (L3, C1). A PR's acceptance report reads as
 * the PR, with where it stands: 「PR #1288 …」 over 「Artifact · 待你审」.
 */
export function ArtifactReviewCard({ artifact, onOpen }: { artifact: ArtifactSummary; onOpen: (id: string) => void }) {
  return artifact.acceptanceTaskId ? <ReportCard artifact={artifact} taskId={artifact.acceptanceTaskId} onOpen={onOpen} /> : <ArtifactCard artifact={artifact} onOpen={onOpen} />
}

function ReportCard({ artifact, taskId, onOpen }: { artifact: ArtifactSummary; taskId: string; onOpen: (id: string) => void }) {
  const text = useArtifactReviewText()
  const review = useArtifactReview(taskId, { hasArtifact: true, runSucceeded: true })
  const title = review.number && review.pullRequest?.title ? text.title(review.number, review.pullRequest.title) : undefined
  return <ArtifactCard artifact={artifact} onOpen={onOpen} title={title} meta={review.detail ? text.line(review.kind) : undefined} icon={<ArtifactIcon className="size-5" />} />
}

/** L3: under a finished thread's last message, the Artifacts it handed over, as cards. Shares the header button's read. */
export function ThreadArtifactCards({ runId }: { runId: string }) {
  const { data } = useRunArtifacts(runId)
  if (!data?.length) return null
  return <div data-slot="thread-artifacts" className="flex flex-col gap-2">{data.map(item => <ArtifactReviewCard key={item.id} artifact={item} onOpen={openArtifact} />)}</div>
}
