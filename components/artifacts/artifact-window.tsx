'use client'

import dynamic from 'next/dynamic'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { getIssueThread } from '@/app/actions/agents'
import { listBots } from '@/app/actions/bots'
import { CoordinatorChat } from '@/components/coordinator/coordinator-chat'
import { BotAvatar, CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { IssueThreadPanel } from '@/components/workspace/issue-thread-panel'
import type { ArtifactListItem } from '@/lib/artifacts/types'

const ArtifactViewer = dynamic(() => import('./artifact-viewer').then(module => module.ArtifactViewer), { ssr: false })

/**
 * An artifact in the reader window (F4 `395:27525`), from the Artifact page or
 * a thread's 「Artifact · N」. One a thread made sits beside that thread's
 * conversation, headed by its name (a skeleton while it loads); its state is
 * the thread's own badge below, the one source (R-34), so the header has no
 * second status dot. A thread takes no quotes, so the window offers none.
 *
 * A run without a task has no thread view, so its artifact sits beside the
 * chat of the bot that ran it (`botId`, from the run): what is typed there
 * goes to the bot that made it (R-56). Only one sent outside a bot's run (an
 * OAuth agent, a Coordinator run) opens beside the Coordinator chat.
 */
export function ArtifactWindow({ artifact, onChange, onClose, onOpenIssue }: { artifact: Pick<ArtifactListItem, 'id' | 'runId' | 'issueId'> & { botId?: string | null }; onChange: (id: string) => void; onClose: () => void; onOpenIssue?: (id: string) => void }) {
  const tNav = useTranslations('Nav')
  const tThreads = useTranslations('IssueThreads')
  const { runId, issueId, botId } = artifact
  // The same key as the thread panel beside it, so both read one request.
  const { data: thread } = useSWR(runId && issueId ? ['issue-thread', issueId, runId] : null, () => getIssueThread(issueId!, runId!))
  const { data: bots, error: botsError } = useSWR(botId && !(runId && issueId) ? 'bots' : null, listBots)
  const bot = botId ? bots?.find(item => item.id === botId) : undefined
  if (runId && issueId) return <ArtifactViewer artifactId={artifact.id} onArtifactChange={onChange} onClose={onClose} quotes={[]} canQuote={false}
    bot={{ name: thread ? thread.thread.detail?.name ?? tThreads('title') : '', avatar: null }}
    chat={() => <IssueThreadPanel issueId={issueId} runId={runId} onClose={onClose} bare />} />
  // The bot's look and name come with the bot list; a bot that is gone, or a list that failed, falls back to the Coordinator.
  if (botId && !bots && !botsError) return <ArtifactViewer artifactId={artifact.id} onArtifactChange={onChange} onClose={onClose} quotes={[]}
    bot={{ name: '', avatar: <Skeleton className="size-5 rounded-full" /> }} chat={() => null} />
  if (bot) return <ArtifactViewer artifactId={artifact.id} onArtifactChange={onChange} onClose={onClose} quotes={[]}
    bot={{ name: bot.name, avatar: <BotAvatar color={bot.color} shape={bot.shape} size="pill" /> }}
    chat={slot => <CoordinatorChat onOpenIssue={onOpenIssue ?? (() => {})} compact embedded={slot} bot={bot} />} />
  return <ArtifactViewer artifactId={artifact.id} onArtifactChange={onChange} onClose={onClose} quotes={[]}
    bot={{ name: tNav('coordinator'), avatar: <CoordinatorAvatar size="pill" /> }}
    chat={slot => <CoordinatorChat onOpenIssue={onOpenIssue ?? (() => {})} compact embedded={slot} />} />
}
