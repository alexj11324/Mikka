'use client'

import dynamic from 'next/dynamic'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { getIssueThread } from '@/app/actions/agents'
import { getArtifact } from '@/app/actions/artifacts'
import { listBots } from '@/app/actions/bots'
import { getCoordinatorChat } from '@/app/actions/coordinator'
import { CoordinatorChat, coordinatorChatKey } from '@/components/coordinator/coordinator-chat'
import { BotAvatar, CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { IssueThreadPanel } from '@/components/workspace/issue-thread-panel'
import { closeArtifact, navigate, openArtifact, openThread } from '@/components/workspace/workspace-navigation'

const ArtifactViewer = dynamic(() => import('./artifact-viewer').then(module => module.ArtifactViewer), { ssr: false })

/** A task chip inside the window opens the task's page; the window closes with the move (R-82). */
const openIssue = (id: string) => navigate({ issue: id })

/**
 * The Artifact window (F4 `395:27525`), shown from the address (`artifact=<id>`)
 * over whatever page it was opened from: a chat's card, a thread's
 * 「Artifact · N」 or the Artifact page (R-56, R-82). Back closes it; a reload
 * or a pasted link opens it again.
 *
 * One a thread made sits beside that thread's conversation, headed by its
 * name (a skeleton while it loads); its state is the thread's own badge below,
 * the one source (R-34), so the header has no second status dot. A thread
 * takes no quotes, so the window offers none.
 *
 * A run without a task has no thread view, so its artifact sits beside the
 * chat of the bot that ran it (`botId`, from the run): what is typed there
 * goes to the bot that made it (R-56). Only one sent outside a bot's run (an
 * OAuth agent, a Coordinator run) opens beside the Coordinator chat.
 */
export function ArtifactWindow({ artifactId }: { artifactId: string }) {
  const tNav = useTranslations('Nav')
  const tThreads = useTranslations('IssueThreads')
  // The same key as the reader inside, so both read one request; only the person's own artifact comes back.
  const { data: detail } = useSWR(['artifact', artifactId], () => getArtifact(artifactId))
  const runId = detail?.runId ?? null
  const issueId = detail?.issueId ?? null
  const botId = detail?.botId ?? null
  const threadMade = Boolean(runId && issueId)
  // The same key as the thread panel beside it, so both read one request.
  const { data: thread } = useSWR(threadMade ? ['issue-thread', issueId, runId] : null, () => getIssueThread(issueId!, runId!))
  const { data: bots, error: botsError } = useSWR(botId && !threadMade ? 'bots' : null, listBots)
  // The Coordinator's own bot is the Coordinator chat, never a second bot.
  const bot = botId ? bots?.find(item => item.id === botId && !item.coordinator) : undefined
  // The chat beside it underlines what it already quoted; the same key as that chat, so one request.
  const chatBotId = bot?.id ?? null
  const { data: chat } = useSWR(detail && !threadMade ? coordinatorChatKey(chatBotId) : null, () => chatBotId ? getCoordinatorChat(chatBotId) : getCoordinatorChat())
  const quotes = chat?.items.flatMap(item => item.quote ? [item.quote] : []) ?? []
  const shared = { artifactId, onArtifactChange: openArtifact, onClose: closeArtifact }
  // Until the artifact says where it came from (or when it is not the person's), the reader shows its own loading or error.
  if (!detail || (botId && !threadMade && !bots && !botsError)) return <ArtifactViewer {...shared} quotes={[]} canQuote={false}
    bot={{ name: '', avatar: <Skeleton className="size-5 rounded-full" /> }} chat={() => null} />
  if (threadMade) return <ArtifactViewer {...shared} quotes={[]} canQuote={false}
    bot={{ name: thread ? thread.thread.detail?.name ?? tThreads('title') : '', avatar: null }}
    chat={() => <IssueThreadPanel issueId={issueId!} runId={runId!} onClose={closeArtifact} onOpenThread={openThread} bare />} />
  // A bot that is gone, or a list that failed, falls back to the Coordinator.
  if (bot) return <ArtifactViewer {...shared} quotes={quotes}
    bot={{ name: bot.name, avatar: <BotAvatar color={bot.color} shape={bot.shape} size="pill" /> }}
    chat={slot => <CoordinatorChat onOpenIssue={openIssue} compact embedded={slot} bot={bot} />} />
  return <ArtifactViewer {...shared} quotes={quotes}
    bot={{ name: tNav('coordinator'), avatar: <CoordinatorAvatar size="pill" /> }}
    chat={slot => <CoordinatorChat onOpenIssue={openIssue} compact embedded={slot} />} />
}
