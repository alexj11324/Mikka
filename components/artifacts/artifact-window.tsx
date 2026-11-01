'use client'

import dynamic from 'next/dynamic'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { getIssueThread } from '@/app/actions/agents'
import { CoordinatorChat } from '@/components/coordinator/coordinator-chat'
import { CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { StatusDot } from '@/components/nav/status-dot'
import { Skeleton } from '@/components/ui/skeleton'
import { IssueThreadPanel } from '@/components/workspace/issue-thread-panel'
import type { ArtifactListItem } from '@/lib/artifacts/types'
import { runIsActive } from '@/lib/issue-run-conversation'

const ArtifactViewer = dynamic(() => import('./artifact-viewer').then(module => module.ArtifactViewer), { ssr: false })

/** A thread's status as the dot in front of its name. */
const dotStatus = (status: string) => status === 'waiting_input' ? 'waiting' : runIsActive(status) ? 'running' : status === 'succeeded' ? 'done' : status

/**
 * An artifact in the reader window (F4 `395:27525`), from the Artifact page or
 * a thread's 「Artifact · N」. One a thread made sits beside that thread's
 * conversation, headed by its status dot and name (a skeleton while they
 * load); a thread takes no quotes, so the window offers none.
 *
 * Artifacts carry no bot: `artifacts` stores the run and issue but not the
 * bot whose chat announced it (`ArtifactSubmitter.botId` only routes the
 * event). One sent outside a run (an OAuth agent) therefore opens beside the
 * Coordinator chat, even when a bot's chat showed its card.
 */
export function ArtifactWindow({ artifact, onChange, onClose, onOpenIssue }: { artifact: Pick<ArtifactListItem, 'id' | 'runId' | 'issueId'>; onChange: (id: string) => void; onClose: () => void; onOpenIssue?: (id: string) => void }) {
  const tNav = useTranslations('Nav')
  const tThreads = useTranslations('IssueThreads')
  const { runId, issueId } = artifact
  // The same key as the thread panel beside it, so both read one request.
  const { data: thread } = useSWR(runId && issueId ? ['issue-thread', issueId, runId] : null, () => getIssueThread(issueId!, runId!))
  if (runId && issueId) return <ArtifactViewer artifactId={artifact.id} onArtifactChange={onChange} onClose={onClose} quotes={[]} canQuote={false}
    bot={{ name: thread ? thread.thread.detail?.name ?? tThreads('title') : '', avatar: thread ? <StatusDot status={dotStatus(thread.thread.status)} /> : <Skeleton className="size-2 rounded-full" /> }}
    chat={() => <IssueThreadPanel issueId={issueId} runId={runId} onClose={onClose} bare />} />
  return <ArtifactViewer artifactId={artifact.id} onArtifactChange={onChange} onClose={onClose} quotes={[]}
    bot={{ name: tNav('coordinator'), avatar: <CoordinatorAvatar size="pill" /> }}
    chat={slot => <CoordinatorChat onOpenIssue={onOpenIssue ?? (() => {})} compact embedded={slot} />} />
}
