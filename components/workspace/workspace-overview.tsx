'use client'

import { Inbox, Layers, Star, Bell } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { listIssues } from '@/app/actions/issues'
import { IssueList } from './issue-list'
import { CoordinatorChat } from '@/components/coordinator/coordinator-chat'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { ISSUE_STATUSES, WORKSPACE_NAME, type IssueView } from './issue-properties'
import type { WorkspaceSection } from './workspace-navigation'

export function WorkspaceOverview({ section, counts, projectCount, onView, onProjects, tasks, userId, onOpen }: { section: WorkspaceSection; counts: Record<IssueView, number>; projectCount: number; onView: (view: IssueView) => void; onProjects: () => void; tasks: Awaited<ReturnType<typeof listIssues>>; userId: string; onOpen: (id: string) => void }) {
  const t = useTranslations('Overview')
  const tIssue = useTranslations('Issue')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  if (section === 'inbox') {
    const following = tasks.filter(task => task.metadata.subscriberUserIds.includes(userId))
    return <section aria-label={t('followingActivityLabel')} className="flex flex-col gap-6 px-5 py-8"><header className="flex flex-col gap-2"><h1 className="text-lg font-semibold">{t('followingTitle')}</h1><p className="text-sm text-muted-foreground">{t('followingDescription')}</p></header>{following.length ? <IssueList issues={following} searching onOpen={onOpen} onCreate={() => onView('all')} /> : <Empty><EmptyHeader><EmptyMedia variant="icon"><Inbox /></EmptyMedia><EmptyTitle>{t('noFollowingTitle')}</EmptyTitle><EmptyDescription>{t('noFollowingDescription')}</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => onView('all')}>{t('viewAllTasks')}</Button></Empty>}</section>
  }
  if (section === 'agent') return <CoordinatorChat />
  return <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10"><header className="flex flex-col gap-2"><h1 className="text-xl font-semibold">{section === 'views' ? t('viewsTitle') : WORKSPACE_NAME}</h1><p className="text-sm text-muted-foreground">{section === 'views' ? t('viewsDescription') : t('teamOverview')}</p></header><div className="flex flex-wrap gap-3"><Button variant="outline" onClick={() => onView('favorites')}><Star data-icon="inline-start" />{t('favorites')} · {counts.favorites}</Button><Button variant="outline" onClick={() => onView('following')}><Bell data-icon="inline-start" />{t('following')} · {counts.following}</Button></div><div className="grid gap-3 sm:grid-cols-2">{ISSUE_STATUSES.map(status => <Button key={status.value} variant="outline" className="h-14 justify-start gap-3" onClick={() => onView(status.value)}><status.icon data-icon="inline-start" /><span>{statusLabel(status.value)}</span><span className="ml-auto text-muted-foreground">{counts[status.value]}</span></Button>)}</div>{section === 'team-home' && <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={onProjects}><Layers data-icon="inline-start" />{t('viewProjects')} · {projectCount}</Button><Button variant="outline" onClick={() => onView('all')}>{t('viewAllTasks')} · {counts.all}</Button></div>}</div>
}
