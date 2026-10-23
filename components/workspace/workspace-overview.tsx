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
import type { AgentHistoryQuery } from './agent-panel'

const AgentPanel = dynamic(() => import('./agent-panel').then(module => module.AgentPanel), { loading: WorkspaceContentLoading })
const CoordinatorChat = dynamic(() => import('@/components/coordinator/coordinator-chat').then(module => module.CoordinatorChat), { loading: WorkspaceContentLoading })

export function WorkspaceOverview({ section, teamName, counts, projectCount, onView, onProjects, tasks, userId, onOpen, agentHistory }: { section: WorkspaceSection; teamName?: string; counts: Record<IssueView, number>; projectCount: number; onView: (view: IssueView) => void; onProjects: () => void; tasks: Awaited<ReturnType<typeof listIssues>>; userId: string; onOpen: (id: string) => void; agentHistory: AgentHistoryQuery }) {
  const i18nText = useTranslations()
  const tIssue = useTranslations('Issue')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  if (section === 'agent') return <AgentPanel key={userId} userId={userId} history={agentHistory} />
  if (section === 'inbox') {
    const following = tasks.filter(task => task.metadata.subscriberUserIds.includes(userId))
    return <section aria-label={i18nText("IssueDetail.menu.subscribe")} className="flex flex-col gap-6 px-5 py-8"><header className="flex flex-col gap-2"><h1 className="text-lg font-semibold">{i18nText("Overview.followingTitle")}</h1><p className="text-sm text-muted-foreground">{i18nText("Overview.followingDescription")}</p></header>{following.length ? <IssueList issues={following} searching onOpen={onOpen} onCreate={() => onView('all')} /> : <Empty><EmptyHeader><EmptyMedia variant="icon"><Inbox /></EmptyMedia><EmptyTitle>{i18nText("Overview.noFollowingTitle")}</EmptyTitle><EmptyDescription>{i18nText("Overview.noFollowingDescription")}</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => onView('all')}>{i18nText("Overview.viewAllTasks")}</Button></Empty>}</section>
  }
  if (section === 'coordinator') return <CoordinatorChat onOpenIssue={onOpen} />
  return <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10"><header className="flex flex-col gap-2"><h1 className="text-xl font-semibold">{section === 'views' ? i18nText("Overview.viewsTitle") : teamName ?? WORKSPACE_NAME}</h1><p className="text-sm text-muted-foreground">{section === 'views' ? i18nText("Overview.viewsDescription") : i18nText("Overview.teamOverview")}</p></header><div className="flex flex-wrap gap-3"><Button variant="outline" onClick={() => onView('favorites')}><Star data-icon="inline-start" />{i18nText("Overview.favorites")} · {counts.favorites}</Button><Button variant="outline" onClick={() => onView('following')}><Bell data-icon="inline-start" />{i18nText("Overview.following")} · {counts.following}</Button></div><div className="grid gap-3 sm:grid-cols-2">{ISSUE_STATUSES.map(status => <Button key={status.value} variant="outline" className="h-14 justify-start gap-3" onClick={() => onView(status.value)}><status.icon data-icon="inline-start" /><span>{statusLabel(status.value)}</span><span className="ml-auto text-muted-foreground">{counts[status.value]}</span></Button>)}</div>{section === 'team-home' && <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={onProjects}><Layers data-icon="inline-start" />{i18nText("Overview.viewProjects")} · {projectCount}</Button><Button variant="outline" onClick={() => onView('all')}>{i18nText("Overview.viewAllTasks")} · {counts.all}</Button></div>}</div>
}
