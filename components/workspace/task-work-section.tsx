'use client'

import { useFormatter, useMessages, useTranslations } from 'next-intl'
import { ChevronRight, GitPullRequest, MessagesSquare } from 'lucide-react'
import type { FactoryActivityView } from '@/lib/factory/activity'
import { type IssueThread, threadQuestionView } from '@/lib/issue-threads'
import type { IssuePullRequest } from '@/lib/issue-metadata'
import { runResult, useRunResultLabel } from '@/hooks/use-run-result'
import { presentedFactoryEvents, taskFactoryProgress } from '@/lib/task-factory-events'
import { navigate } from './workspace-navigation'
import type { TaskPresentation } from '@/lib/task-presentation'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'

type Pull = { url: string; title?: string | null; state: string | null; runId?: string | null }

function linkedPulls(saved: readonly IssuePullRequest[], factory?: FactoryActivityView | null) {
  const pulls = new Map<string, Pull>(saved.map(pull => [pull.url, pull]))
  const candidate = factory?.task.pullRequest
  if (candidate) pulls.set(candidate.url, { ...pulls.get(candidate.url), ...candidate })
  for (const artifact of factory?.artifacts ?? []) {
    if (artifact.kind !== 'pull_request') continue
    const prior = pulls.get(artifact.url)
    pulls.set(artifact.url, { ...prior, url: artifact.url, title: artifact.title || prior?.title,
      state: artifact.state || prior?.state || null, runId: artifact.runId })
  }
  return [...pulls.values()].filter(pull => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/.test(pull.url))
}

export function TaskWorkSection({ threads, pulls, linkedChats = [], factory, open }: {
  linkedChats?: TaskPresentation['linkedChats']
  threads: readonly IssueThread[]
  pulls: readonly IssuePullRequest[]
  factory?: FactoryActivityView | null
  open: (id: string) => void
}) {
  const t = useTranslations('IssueDetail.work')
  const directory = useTranslations('ConversationDirectory')
  const tThread = useTranslations('IssueThreads')
  const messages = useMessages()
  const format = useFormatter()
  const states: Record<string, string> = messages.IssueDetail.work.states
  const resultLabel = useRunResultLabel()
  const conversations = threads
  const linked = linkedPulls(pulls, factory)
  const progress = taskFactoryProgress(presentedFactoryEvents(factory?.events, factory?.task.id))
  if (!conversations.length && !linkedChats.length && !linked.length && !progress.length) return null
  const byRun = new Map(conversations.flatMap(thread => [thread.id, ...thread.attempts.map(attempt => attempt.runId)].map(id => [id, thread] as const)))
  const labelStage = (stage: string) => (messages.GroupTask.stage as Record<string, string>)[stage] ?? stage
  const labelStatus = (status: string) => (messages.GroupTask.status as Record<string, string>)[status] ?? status
  return <section aria-label={t('heading')} className="my-4 flex flex-col gap-1" data-slot="task-work">
    <h2 className="mb-2 text-sm font-semibold">{t('heading')}</h2>
    {linkedChats.map(chat => <Button key={'chat:' + chat.id} variant="ghost"
      onClick={() => navigate({ section: 'group', group: chat.id, issue: null, thread: null, task: null })}
      className="h-auto w-full justify-start gap-2 px-1 py-2 text-left whitespace-normal">
      <MessagesSquare data-icon="inline-start" aria-hidden="true" className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{chat.title || directory('untitled')}</span>
      <ChevronRight data-icon="inline-end" aria-hidden="true" className="shrink-0 text-muted-foreground" />
    </Button>)}
    {conversations.map(thread => {
      const detail = thread.detail
      const view = threadQuestionView(thread)
      const { result, reason } = runResult({ status: view.waiting ? 'waiting_input' : view.status, outcome: view.outcome }, true)
      const name = detail?.name || (thread.ownerName ? tThread('ownerThread', { name: thread.ownerName }) : tThread('hidden'))
      if (!detail) return <div key={thread.id} className="flex items-center gap-2 px-1 py-2 text-sm">
        <MessagesSquare aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{name}</span><span className="text-xs text-muted-foreground">{resultLabel(result, reason)}</span>
      </div>
      return <Button key={thread.id} variant="ghost" onClick={() => open(thread.id)} className="h-auto w-full justify-start gap-2 px-1 py-2 text-left whitespace-normal">
        <MessagesSquare data-icon="inline-start" aria-hidden="true" className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1"><span className="block truncate">{name}</span>
          <span className="block text-xs font-normal text-muted-foreground">{[detail.profile?.name || detail.agentName, detail.observedModel, view.stopping ? tThread('stopping') : resultLabel(result, reason)].filter(Boolean).join(' · ')}</span>
          {detail.summary && <span className="line-clamp-2 text-xs font-normal">{detail.summary}</span>}</span>
        <ChevronRight data-icon="inline-end" aria-hidden="true" className="shrink-0 text-muted-foreground" />
      </Button>
    })}
    {linked.map(pull => {
      const detail = pull.runId ? byRun.get(pull.runId)?.detail : null
      const number = pull.url.split('/').filter(Boolean).at(-1)
      const state = pull.state?.toLowerCase()
      const status = state ? states[state] : null
      return <a key={pull.url} href={pull.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md px-1 py-2 text-sm hover:bg-muted">
        <GitPullRequest aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0">
          <span className="block truncate">#{number}{pull.title && ' '+pull.title}</span>
          <span className="block text-xs text-muted-foreground">{[detail?.name, detail?.profile?.name || detail?.agentName, detail?.observedModel, status].filter(Boolean).join(' · ')}</span>
          {detail?.summary && <span className="line-clamp-2 text-xs">{detail.summary}</span>}
        </span></a>
    })}
    {progress.map(group => <Collapsible key={group.id} className="text-sm">
      <CollapsibleTrigger className="cursor-pointer rounded-md py-2 text-left">{[group.runId ? byRun.get(group.runId)?.detail?.agentName : null, labelStage(group.current.stage), labelStatus(group.current.status)].filter(Boolean).join(' · ')}</CollapsibleTrigger>
      <CollapsibleContent>
      <ol className="ms-5 flex flex-col gap-1 border-s ps-3">{group.steps.map(step => <li key={step.id} className="text-xs">
        {labelStage(step.stage)} · {labelStatus(step.status)} <time className="text-muted-foreground" dateTime={step.at}>{format.dateTime(new Date(step.at), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
      </li>)}</ol>
    </CollapsibleContent>
    </Collapsible>)}
  </section>
}
