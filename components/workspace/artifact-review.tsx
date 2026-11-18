'use client'

import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { useRunArtifacts } from '@/hooks/use-thread-run-reads'
import { ArtifactIcon } from '@/components/icons/artifact-icon'
import { ArtifactCard, ArtifactChip } from '@/components/artifacts/artifact-card'
import { useLiveKey } from '@/hooks/use-live-key'
import { flowMergeAcceptance, mergeAcceptance, type AcceptanceMerge } from '@/lib/factory/acceptance-state'
import { artifactReviewKind, pullNumberOf, type ArtifactReviewKind } from '@/lib/factory/artifact-review'
import { request } from '@/lib/factory/browser-request'
import type { ArtifactSummary } from '@/lib/artifacts/types'
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
    line: (kind: ArtifactReviewKind) => t('tooltipState', { state: t(`state.${kind === 'none' || kind === 'preparing' || kind === 'ready' ? 'review' : kind}`) }),
    title: (number: string, title: string) => t('cardTitle', { number, title }),
  }
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

/** The run's delivered documents open directly from their own chips. */
export function ThreadArtifactChips({ runId, documents }: { runId: string; documents?: readonly { id: string; title: string; latestVersion: number | null }[] }) {
  const { data } = useRunArtifacts(runId)
  const items = new Map((documents ?? []).map(item => [item.id, item]))
  for (const item of data ?? []) items.set(item.id, item)
  if (!items.size) return null
  return <div data-slot="thread-artifact-chips" className="flex flex-wrap gap-1.5">{Array.from(items.values(), item => <ArtifactChip key={item.id} artifact={item} active={false} onOpen={openArtifact} />)}</div>
}
