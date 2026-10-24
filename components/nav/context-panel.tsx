'use client'

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import useSWR from 'swr'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { ArrowUp, BookOpen, ChevronRight, CircleCheck, Clock, Globe, Info, Maximize2, Minimize2, RotateCw, Search, X, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { listIssues } from '@/app/actions/issues'
import type { TaskRun, Thread } from '@/app/actions/task-runs'
import { sendCoordinatorMessage } from '@/app/actions/coordinator'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { issueIdentifier } from '@/components/workspace/issue-properties'
import { withBasePath } from '@/lib/base-path'
import type { SuggestionAction, SuggestionSource } from '@/lib/db/schema'
import { cn } from '@/lib/utils'
import { LetterAvatar } from './letter-avatar'
import { StatusDot } from './status-dot'
import { AgentComputer } from '@/components/computer/agent-computer'
import { useConversationThread } from '@/components/computer/computer-agents'
import { BotAvatar } from './bot-avatar'
import { ThreadList, ThreadMark, threadName } from './thread-list'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
export type PanelTab = 'details' | 'tasks' | 'browser' | 'knowledge' | 'schedules'

const TABS: { id: PanelTab; icon: LucideIcon }[] = [
  { id: 'details', icon: Info },
  { id: 'tasks', icon: CircleCheck },
  { id: 'browser', icon: Globe },
  { id: 'knowledge', icon: BookOpen },
  { id: 'schedules', icon: Clock },
]

type SuggestionItem = { id: string; source: SuggestionSource; action: SuggestionAction; title: string; url: string | null }
type SuggestionsView = {
  briefing: { total: number; highlights: SuggestionItem[] } | null
  groups: { source: SuggestionSource; items: SuggestionItem[] }[]
}

const fetchSuggestions = async (url: string): Promise<SuggestionsView> => {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(String(response.status))
  return response.json()
}

function SourceMark({ source }: { source: SuggestionSource }) {
  return <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-xs',
    source === 'gmail' && 'bg-destructive', source === 'github' && 'bg-muted-foreground', source === 'linear' && 'bg-label-violet',
    source === 'notion' && 'bg-foreground', source === 'slack' && 'bg-avatar-2')} />
}

/** An inline source chip: the app's mark and the item's own title (MIK-28). */
function SourceChip({ item }: { item: SuggestionItem }) {
  const body = <><SourceMark source={item.source} /><span className="truncate">{item.title}</span></>
  const className = 'inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 align-middle text-xs text-foreground'
  return item.url ? <a href={item.url} target="_blank" rel="noreferrer" className={cn(className, 'hover:bg-accent')}>{body}</a> : <span className={className}>{body}</span>
}

function greetingKey(now: Date) {
  const hour = now.getHours()
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
}

/** 建议: today's briefing and the routine items by source app, from GET /api/suggestions (MIK-28). */
function Suggestions({ name }: { name: string }) {
  const t = useTranslations('Shell.suggestions')
  const timeZone = typeof Intl === 'undefined' ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone
  const { data, error, isValidating, mutate } = useSWR(withBasePath(`/api/suggestions?tz=${encodeURIComponent(timeZone)}`), fetchSuggestions, { revalidateOnFocus: false })
  const empty = data && !data.briefing && !data.groups.length
  return <section aria-label={t('title')} className="flex flex-col gap-2">
    <div className="flex items-center justify-between">
      <h2 className="text-xs font-medium text-muted-foreground">{t('title')}</h2>
      <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={t('refresh')} disabled={isValidating} onClick={() => { void mutate() }} />}><RotateCw data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('refresh')}</TooltipContent></Tooltip>
    </div>
    <p className="text-lg font-semibold">{t(greetingKey(new Date()), { name })}</p>
    {error && <p role="alert" className="text-xs text-destructive">{t('loadError')}</p>}
    {data?.briefing?.highlights.length ? <p className="text-sm leading-relaxed text-muted-foreground">{t('briefing', { count: data.briefing.total })} {data.briefing.highlights.map(item => <SourceChip key={item.id} item={item} />).reduce<ReactNode[]>((all, chip, index) => index ? [...all, ' ', chip] : [chip], [])}</p>
      : data && !empty && <p className="text-sm text-muted-foreground">{t('noneToday')}</p>}
    {data && !!data.groups.length && <>
      <h3 className="pt-2 text-xs font-medium text-muted-foreground">{t('routine')}</h3>
      {data.groups.map(group => <div key={group.source} className="flex flex-col gap-2 rounded-xl bg-muted/50 p-3">
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><SourceMark source={group.source} />{t(`source.${group.source}`)}</p>
        {group.items.map(item => <p key={item.id} className="flex min-w-0 items-center gap-2 text-sm"><span className="shrink-0">{t(`action.${item.action}`)}</span><SourceChip item={item} /></p>)}
      </div>)}
    </>}
    {empty && <Empty className="py-10"><EmptyHeader><EmptyTitle>{t('emptyTitle')}</EmptyTitle><EmptyDescription>{t('emptyDescription')}</EmptyDescription></EmptyHeader></Empty>}
  </section>
}

type Group = 'waiting' | 'running' | 'failed' | 'done'
function groupOf(run: TaskRun, today: string): Group | null {
  if (run.status === 'waiting_input') return 'waiting'
  if (['queued', 'preparing', 'running', 'finishing'].includes(run.status)) return 'running'
  if (run.status === 'failed') return 'failed'
  if (run.status === 'succeeded' && run.finishedAt && new Date(run.finishedAt).toDateString() === today) return 'done'
  return null
}

/** Rows for one run each: dot, task, what it waits for, the agent (MIK-38). */
function TaskRows({ rows, onOpenIssue }: { rows: { run: TaskRun; issue: Issue; group: Group }[]; onOpenIssue: (id: string) => void }) {
  const t = useTranslations('Shell.tasks')
  return <ul className="flex flex-col">
    {rows.map(({ run, issue, group }) => <li key={issue.id}>
      <Button variant="ghost" className="h-8 w-full justify-start gap-3 rounded-lg px-2 font-normal" onClick={() => onOpenIssue(issue.id)}>
        <StatusDot status={group} />
        <span className="min-w-0 flex-1 truncate text-left">{issue.scope === 'workspace' && <span className="tabular-nums">{issueIdentifier(issue)} </span>}{issue.title}</span>
        {group !== 'running' && group !== 'done' && <span className={cn('shrink-0 text-xs', group === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{run.status === 'failed' ? run.error?.split('\n')[0]?.slice(0, 16) || t('status.failed') : t('status.waiting_input')}</span>}
        <LetterAvatar name={run.agentName} size="row" />
      </Button>
    </li>)}
  </ul>
}

function MyTasks({ issues, runs, onOpenIssue }: { issues: Issue[]; runs: TaskRun[]; onOpenIssue: (id: string) => void }) {
  const t = useTranslations('Shell.tasks')
  const today = new Date().toDateString()
  const byId = new Map(issues.map(issue => [issue.id, issue]))
  const rows = runs.flatMap(run => { const issue = byId.get(run.issueId); const group = groupOf(run, today); return issue && group ? [{ run, issue, group }] : [] })
  const groups: { id: Group; label: string }[] = [{ id: 'waiting', label: t('waiting') }, { id: 'running', label: t('running') }, { id: 'failed', label: t('failed') }]
  const done = rows.filter(row => row.group === 'done')
  return <section aria-label={t('mine')} className="flex flex-col gap-2">
    <h2 className="text-sm font-semibold">{t('mine')}</h2>
    {!rows.length && <p className="text-xs text-muted-foreground">{t('empty')}</p>}
    {groups.map(group => {
      const list = rows.filter(row => row.group === group.id)
      return list.length > 0 && <div key={group.id} className="flex flex-col gap-1">
        <h3 className="text-xs text-muted-foreground">{group.label} · {list.length}</h3>
        <TaskRows rows={list} onOpenIssue={onOpenIssue} />
      </div>
    })}
    {done.length > 0 && <Collapsible className="flex flex-col gap-1">
      <CollapsibleTrigger render={<Button variant="ghost" size="xs" className="group w-fit gap-1 px-0 font-normal text-muted-foreground hover:bg-transparent" />}>{t('doneToday')} · {t('today', { count: done.length })}<ChevronRight data-icon="inline-end" className="transition-transform group-data-panel-open:rotate-90" /></CollapsibleTrigger>
      <CollapsibleContent><TaskRows rows={done} onOpenIssue={onOpenIssue} /></CollapsibleContent>
    </Collapsible>}
  </section>
}

/** 指挥这个任务…: one line to the Coordinator from the right column. */
function CommandComposer() {
  const t = useTranslations('Shell.tasks')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  async function send(event?: FormEvent) {
    event?.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const result = await sendCoordinatorMessage(text)
      if (result.error) throw new Error(result.error)
      setDraft('')
      toast.success(t('sent'))
    } catch { toast.error(t('sendFailed')) } finally { setSending(false) }
  }
  return <form onSubmit={send} className="shrink-0 p-3">
    <InputGroup className="rounded-xl bg-muted/50">
      <InputGroupTextarea aria-label={t('commandLabel')} placeholder={t('command')} rows={1} value={draft} disabled={sending} className="min-h-10" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
      {draft.trim() && <InputGroupAddon align="inline-end"><InputGroupButton type="submit" variant="default" size="icon-xs" aria-label={t('send')} disabled={sending}><ArrowUp /></InputGroupButton></InputGroupAddon>}
    </InputGroup>
  </form>
}

function EmptyTab({ title, onArrange, arrangeLabel }: { title: string; onArrange?: () => void; arrangeLabel?: string }) {
  const t = useTranslations('Shell.empty')
  return <div className="flex flex-1 flex-col">
    <h2 className="text-lg font-semibold">{title}</h2>
    <Empty className="flex-1"><EmptyHeader><EmptyDescription>{t('nothing')}</EmptyDescription></EmptyHeader>{onArrange && <Button variant="secondary" className="rounded-full" onClick={onArrange}>{arrangeLabel}</Button>}</Empty>
  </div>
}

/** Who the center chat is with. For a bot, `id` is the bot's id; for an older chat, the chat's id. */
export type PanelConversation = { id?: string | null; name: string; color?: string; shape?: string; kind: 'coordinator' | 'bot' | 'agent'; updatedAt?: string }

/**
 * The right column beside a chat (MIK-37, Figma 48:3): 详情 / 任务 /
 * 浏览器 / 知识库 / 定时任务. The current tab shows its name, the others only
 * their icons; ⤢ widens just this column. With a bot (Figma 188:3115), 任务
 * becomes that bot's thread list and 详情 shows the picked thread (newest
 * first) on the bot's computer; picking another bot switches both.
 */
export function ContextPanel({ userName, issues, runs, threads, conversation, onOpenIssue, onArrange, onSearch, onClose }: {
  userName: string
  issues: Issue[]
  runs: TaskRun[]
  threads: Thread[]
  conversation: PanelConversation
  onOpenIssue: (id: string) => void
  onArrange: (prompt: string) => void
  onSearch: () => void
  onClose: () => void
}) {
  const t = useTranslations('Shell.panel')
  const tEmpty = useTranslations('Shell.empty')
  const tDetails = useTranslations('Shell.details')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const [tab, setTab] = useState<PanelTab>('tasks')
  const [wide, setWide] = useState(false)
  const tThreads = useTranslations('Shell.threads')
  const botId = conversation.kind === 'bot' ? conversation.id ?? null : null
  const botThreads = botId ? threads.filter(thread => thread.botId === botId) : []
  const [picked, setPicked] = useState<string | null>(null)
  const thread = botThreads.find(item => item.id === picked) ?? botThreads[0]
  // Another bot: back to its 详情 and its newest thread.
  useEffect(() => { if (botId) { setTab('details'); setPicked(null) } }, [botId])
  // With a bot, the badge counts its threads waiting on you; otherwise every task's.
  const waiting = botId ? botThreads.filter(item => item.status === 'waiting_input').length : runs.filter(run => run.status === 'waiting_input' && issues.some(issue => issue.id === run.issueId)).length
  // An older chat without a bot learns its thread from the 电脑 cards in it.
  const registered = useConversationThread(conversation.kind === 'agent' ? conversation.id : null)
  const computer = botId ?? registered?.botId
  // A conversation whose bot works on its computer opens on that thread's 详情, where the screen is (Figma 103:64).
  useEffect(() => { if (registered?.runId) setTab('details') }, [registered?.runId])

  return <aside aria-label={t('label')} className={cn('hidden min-h-0 shrink-0 flex-col border-l transition-[width] duration-150 ease-out motion-reduce:transition-none xl:flex', wide ? 'w-130' : 'w-90')}>
    <Tabs value={tab} onValueChange={value => setTab(value as PanelTab)} className="min-h-0 flex-1 gap-0">
      <div className="flex h-11 shrink-0 items-center gap-1 px-2">
        <TabsList aria-label={t('tabs')} className="gap-0.5 bg-transparent p-0">
          {TABS.map(item => {
            const label = botId && item.id === 'tasks' ? tThreads('title') : t(item.id)
            return <TabsTrigger key={item.id} value={item.id} aria-label={label} className={cn('h-7 flex-none rounded-md px-1.5 data-active:bg-muted! data-active:shadow-none', tab === item.id && 'px-2')}>
            <item.icon />
            {tab === item.id && <span>{label}</span>}
            {item.id === 'tasks' && waiting > 0 && <span className="flex size-4 items-center justify-center rounded-full bg-sidebar-primary text-xs leading-none text-sidebar-primary-foreground tabular-nums">{waiting}</span>}
          </TabsTrigger>
          })}
        </TabsList>
        <div className="ml-auto flex items-center">
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={t('search')} onClick={onSearch} />}><Search data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('search')}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={wide ? t('narrow') : t('widen')} aria-pressed={wide} onClick={() => setWide(value => !value)} />}>{wide ? <Minimize2 data-icon="inline-start" /> : <Maximize2 data-icon="inline-start" />}</TooltipTrigger><TooltipContent>{wide ? t('narrow') : t('widen')}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={t('close')} onClick={onClose} />}><X data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('close')}</TooltipContent></Tooltip>
        </div>
      </div>
      <TabsContent value="details" className={cn('min-h-0', computer ? 'flex flex-col' : 'overflow-y-auto px-4 py-3')}>
        {computer ? <>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{botId
            ? <AgentComputer botId={botId} name={conversation.name} caption={tThreads('screen')}
              head={thread ? { avatar: <ThreadMark />, title: threadName(thread, issues, tThreads('untitled')) } : { avatar: <BotAvatar color={conversation.color} shape={conversation.shape} size="profile" />, title: conversation.name }} />
            : registered && <AgentComputer key={registered.runId} botId={registered.botId} name={registered.botName} head={{ avatar: <ThreadMark />, title: registered.name }} />}</div>
          <CommandComposer />
        </> : <>
        <h2 className="text-xs font-medium text-muted-foreground">{tDetails('conversation')}</h2>
        <div className="flex items-center gap-3 py-3"><LetterAvatar name={conversation.name} tone={conversation.kind === 'coordinator' ? 'coordinator' : undefined} /><p className="min-w-0 truncate font-semibold">{conversation.name}</p></div>
        <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">{tDetails('kind')}</dt><dd>{conversation.kind === 'coordinator' ? tDetails('coordinatorKind') : tDetails('agentKind')}</dd>
          <dt className="text-muted-foreground">{tDetails('updated')}</dt><dd>{conversation.updatedAt ? format.relativeTime(new Date(conversation.updatedAt), now) : tDetails('none')}</dd>
        </dl>
        </>}
      </TabsContent>
      <TabsContent value="tasks" className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-3">
          {botId ? <section aria-label={tThreads('title')} className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">{tThreads('title')}</h2>
            <ThreadList threads={botThreads} issues={issues} current={thread?.id ?? null} onPick={id => { setPicked(id); setTab('details') }} />
          </section> : <>
            <Suggestions name={userName} />
            <MyTasks issues={issues} runs={runs} onOpenIssue={onOpenIssue} />
          </>}
        </div>
        <CommandComposer />
      </TabsContent>
      <TabsContent value="browser" className="flex min-h-0 flex-col px-4 py-3"><EmptyTab title={t('browser')} /></TabsContent>
      <TabsContent value="knowledge" className="flex min-h-0 flex-col px-4 py-3"><EmptyTab title={t('knowledge')} arrangeLabel={tEmpty('arrange')} onArrange={() => onArrange(tEmpty('knowledgePrompt'))} /></TabsContent>
      <TabsContent value="schedules" className="flex min-h-0 flex-col px-4 py-3"><EmptyTab title={t('schedules')} arrangeLabel={tEmpty('arrange')} onArrange={() => onArrange(tEmpty('schedulesPrompt'))} /></TabsContent>
    </Tabs>
  </aside>
}
