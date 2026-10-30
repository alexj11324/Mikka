'use client'
import { useTranslations } from 'next-intl'

import { Inbox, Layers, Star, Bell } from 'lucide-react'
import type { listIssues } from '@/app/actions/issues'
import { IssueList } from './issue-list'
import dynamic from 'next/dynamic'
import { WorkspaceContentLoading } from './workspace-loading'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { ISSUE_STATUSES, WORKSPACE_NAME, type IssueView } from './issue-properties'
import type { WorkspaceSection } from './workspace-navigation'
import type { AgentHistory, SavedAgentSession } from '@/lib/agent-history'
import type { LegacyChatRequest } from './legacy-chat-archive'
import { ConversationPill } from '@/components/nav/conversation-pill'
import { BotAvatar, COORDINATOR_AVATAR } from '@/components/nav/bot-avatar'
import type { BotView } from '@/app/actions/bots'
import type { CoordinatorPrefill } from '@/components/coordinator/coordinator-chat'

const LegacyChatArchive = dynamic(() => import('./legacy-chat-archive').then(module => module.LegacyChatArchive), { loading: WorkspaceContentLoading })
const CoordinatorChat = dynamic(() => import('@/components/coordinator/coordinator-chat').then(module => module.CoordinatorChat), { loading: WorkspaceContentLoading })

export function WorkspaceOverview({ section, teamName, counts, projectCount, onView, onProjects, tasks, userId, onOpen, initialAgentHistory, agentRequest, onAgentActive, onAgentSessions, coordinatorPrefill, bot }: { bot?: BotView; onAgentSessions?: (sessions: SavedAgentSession[]) => void; coordinatorPrefill?: CoordinatorPrefill; section: WorkspaceSection; teamName?: string; counts: Record<IssueView, number>; projectCount: number; onView: (view: IssueView) => void; onProjects: () => void; tasks: Awaited<ReturnType<typeof listIssues>>; userId: string; onOpen: (id: string) => void; initialAgentHistory?: AgentHistory; agentRequest?: LegacyChatRequest; onAgentActive?: (sessionId: string | null) => void }) {
  const i18nText = useTranslations()
  const tIssue = useTranslations('Issue')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  if (section === 'agent') return <LegacyChatArchive key={userId} userId={userId} initialHistory={initialAgentHistory} request={agentRequest} onActive={onAgentActive} onSessions={onAgentSessions} />
  if (section === 'inbox') {
    const following = tasks.filter(task => task.metadata.subscriberUserIds.includes(userId))
    return <section aria-label={i18nText("IssueDetail.menu.subscribe")} className="flex flex-col gap-6 px-5 py-8"><header className="flex flex-col gap-2"><h1 className="text-lg font-semibold">{i18nText("Overview.followingTitle")}</h1><p className="text-sm text-muted-foreground">{i18nText("Overview.followingDescription")}</p></header>{following.length ? <IssueList issues={following} searching onOpen={onOpen} onCreate={() => onView('all')} /> : <Empty><EmptyHeader><EmptyMedia variant="icon"><Inbox /></EmptyMedia><EmptyTitle>{i18nText("Overview.noFollowingTitle")}</EmptyTitle><EmptyDescription>{i18nText("Overview.noFollowingDescription")}</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => onView('all')}>{i18nText("Overview.viewAllTasks")}</Button></Empty>}</section>
  }
  // An open thread brings its own header, so the chat's pill steps aside (R-66). A bot's chat is the Coordinator's harness under the bot's name.
  if (section === 'coordinator') return <div className="relative flex min-h-0 flex-1 flex-col has-data-[slot=thread-view]:[&_[data-slot=conversation-pill]]:hidden">
    <ConversationPill name={bot ? bot.name : i18nText('Nav.coordinator')} avatar={<BotAvatar {...(bot ? { color: bot.color, shape: bot.shape } : COORDINATOR_AVATAR)} size="pill" />} />
    <CoordinatorChat key={bot?.id ?? 'coordinator'} bot={bot} userId={userId} onOpenIssue={onOpen} prefill={bot ? undefined : coordinatorPrefill} />
  </div>
  return <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10"><header className="flex flex-col gap-2"><h1 className="text-xl font-semibold">{section === 'views' ? i18nText("Overview.viewsTitle") : teamName ?? WORKSPACE_NAME}</h1><p className="text-sm text-muted-foreground">{section === 'views' ? i18nText("Overview.viewsDescription") : i18nText("Overview.teamOverview")}</p></header><div className="flex flex-wrap gap-3"><Button variant="outline" onClick={() => onView('favorites')}><Star data-icon="inline-start" />{i18nText("Overview.favorites")} · {counts.favorites}</Button><Button variant="outline" onClick={() => onView('following')}><Bell data-icon="inline-start" />{i18nText("Overview.following")} · {counts.following}</Button></div><div className="grid gap-3 sm:grid-cols-2">{ISSUE_STATUSES.map(status => <Button key={status.value} variant="outline" className="h-14 justify-start gap-3" onClick={() => onView(status.value)}><status.icon data-icon="inline-start" /><span>{statusLabel(status.value)}</span><span className="ml-auto text-muted-foreground">{counts[status.value]}</span></Button>)}</div>{section === 'team-home' && <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={onProjects}><Layers data-icon="inline-start" />{i18nText("Overview.viewProjects")} · {projectCount}</Button><Button variant="outline" onClick={() => onView('all')}>{i18nText("Overview.viewAllTasks")} · {counts.all}</Button></div>}</div>
}
