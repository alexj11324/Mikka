'use client'

import { createContext, memo, useCallback, useContext, useMemo, useState, type ComponentType } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import {
  BellRing, BookOpen, Brain, CalendarDays, ChevronsDownUp, ChevronsUpDown, CircleAlert, CircleCheckIcon, CircleStop, Factory, FolderGit2, FolderOpen, Globe, ListChecks,
  LoaderCircleIcon, Mail, MessageSquare, MessageSquareText, Pencil, Search, Send, SquarePlus, Wrench,
} from 'lucide-react'
import { coordinatorReasoning } from '@/app/actions/coordinator'
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GitHubIcon } from '@/components/icons/brand-icons'
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'
import { toolAction, toolFailure, toolObjectId, toolSummary, toolTarget, type ToolAction } from '@/lib/coordinator/tool-activity'
import { useAgentCitations } from '@/components/workspace/agent-citations'
import { runThreadName } from '@/lib/coordinator/citations'
import type { ChatTool } from '@/lib/coordinator/context'
import { cn } from '@/lib/utils'

/**
 * 全部展开 / 全部收起 for every tool group in the chat (R-83). `seq` counts the presses: a group follows the latest press
 * until the reader opens or closes that group alone. `open` is null before any press.
 */
export const ActivityExpansionContext = createContext<{ open: boolean | null; seq: number; toggle: () => void } | null>(null)

/** The chat's state for 全部展开 / 全部收起, to put in ActivityExpansionContext. */
export function useActivityExpansion() {
  const [state, setState] = useState<{ open: boolean | null; seq: number }>({ open: null, seq: 0 })
  const toggle = useCallback(() => setState(current => ({ open: !current.open, seq: current.seq + 1 })), [])
  return useMemo(() => ({ ...state, toggle }), [state, toggle])
}

/** A collapsible that follows 全部展开 until the reader sets it alone; `fallback` while neither has. */
function useFollowedOpen(fallback: boolean) {
  const all = useContext(ActivityExpansionContext)
  const [own, setOwn] = useState<{ open: boolean; seq: number } | null>(null)
  const seq = all?.seq ?? 0
  const open = own && own.seq === seq ? own.open : all?.open ?? fallback
  return [open, (next: boolean) => setOwn({ open: next, seq })] as const
}

const ACTION_ICONS: Record<ToolAction, ComponentType<{ className?: string }>> = {
  dispatch: Send, messageThread: MessageSquareText, stopThread: CircleStop, createIssue: SquarePlus, updateIssue: Pencil,
  sendMail: Mail, sendSlack: MessageSquare, writeNotion: Pencil, writeCalendar: CalendarDays, remember: Brain, forget: Brain,
  schedule: BellRing, factory: Factory, github: GitHubIcon, viewIssues: ListChecks, viewThreads: MessageSquareText,
  searchWeb: Search, readWeb: Globe, readMail: Mail, readSlack: MessageSquare, readNotion: BookOpen, viewCalendar: CalendarDays,
  viewDrive: FolderOpen, viewFactory: Factory, findRepository: FolderGit2, other: Wrench,
}

/**
 * Thinking as shadcn/ui's Trace draws it (ui.shadcn.com/docs/components/base/trace, its Reasoning row): "Thinking"
 * with a spinner while the model thinks, open as the words stream in; "Thought for N seconds" with a check once it
 * stops, closed. A reader's own click wins either way. Without readable reasoning it is a line that does not open.
 */
function ThinkingRow({ running, title, text, onOpen }: { running: boolean; title: string; text?: string; onOpen?: () => void }) {
  const [open, setOpen] = useState<boolean>()
  const line = <TraceLine status={running ? 'running' : undefined}>
    <TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : <CircleCheckIcon />}</TraceIcon>
    <TraceTitle>{title}</TraceTitle>
  </TraceLine>
  if (text === undefined) return <div data-activity-thinking={running ? 'active' : 'done'} data-reasoning="none">{line}</div>
  return <TraceCollapsible data-activity-thinking={running ? 'active' : 'done'} data-reasoning="readable" open={open ?? running}
    onOpenChange={next => { setOpen(next); if (next) onOpen?.() }}>
    <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
    <TraceCollapsibleContent className="whitespace-pre-wrap">{text}</TraceCollapsibleContent>
  </TraceCollapsible>
}

/** A tool's name as the person reads it: its label, or its own name spelled out; never 「使用工具」 (R-83). */
function useToolLabel() {
  const t = useTranslations('Coordinator.activity')
  return (name: string) => t.has(`tools.${name}` as never) ? t(`tools.${name}` as never) : name.replace(/^mcp__/, '').replace(/__|_/g, ' ')
}

/** A failure's reason in words: a known error code in the person's language, any other code or message as it is. */
function useFailureReason() {
  const t = useTranslations('Coordinator.activity')
  return (reason: string | null) => reason && t.has(`errors.${reason}` as never) ? t(`errors.${reason}` as never) : reason
}

/**
 * One tool call (R-83): its kind's icon, then what it did to what (「查看任务 ALEX-45」). Running, it spins; failed, it is
 * red and says why (「派发 Factory 任务 · 没有找到 Factory 任务」), also when the tool answered an error instead of
 * throwing. Its raw input and output open only from this row.
 */
function ToolRow({ tool, live }: { tool: ChatTool; live: boolean }) {
  const t = useTranslations('Coordinator.activity')
  const label = useToolLabel()(tool.name)
  const reasonText = useFailureReason()
  const sources = useAgentCitations()?.sources
  // A task or thread named by id reads as its number or name, as the chips in the words do.
  const object = sources?.[toolObjectId(tool) ?? '']
  const target = object ? object.kind === 'run' ? runThreadName(object) : object.identifier ?? object.title : toolTarget(tool)
  const Icon = ACTION_ICONS[toolAction(tool.name)]
  const running = tool.state === 'running' && live
  // A call still running when its reply ended never finished.
  const { failed, reason } = tool.state === 'running' ? { failed: !live, reason: null } : toolFailure(tool)
  const why = failed ? reasonText(reason) : null
  const line = <TraceLine status={running ? 'running' : failed ? 'error' : undefined}>
    <TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : failed ? <CircleAlert /> : <Icon />}</TraceIcon>
    <TraceTitle>
      {running ? t('running', { tool: label }) : label}
      {target && <span className={cn('ml-1.5', !failed && 'text-muted-foreground/70')}>{target}</span>}
      {why && <span className="ml-1.5">· {why}</span>}
    </TraceTitle>
  </TraceLine>
  const detail = [tool.input, tool.output].filter(Boolean)
  if (!detail.length || running) return <div data-activity-tool={running ? 'running' : failed ? 'error' : 'done'}>{line}</div>
  return <TraceCollapsible data-activity-tool={failed ? 'error' : 'done'}>
    <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
    <TraceCollapsibleContent className="flex flex-col gap-2">
      {tool.input && <CodeBlock size="sm"><CodeBlockContent wrap className="max-h-40">{tool.input}</CodeBlockContent></CodeBlock>}
      {tool.output && <CodeBlock size="sm" {...(failed ? { variant: 'destructive' as const } : {})}><CodeBlockContent wrap className="max-h-64">{tool.output}</CodeBlockContent></CodeBlock>}
    </TraceCollapsibleContent>
  </TraceCollapsible>
}

/** 全部展开 / 全部收起, at the end of a group's summary; it opens or closes every group in the chat (R-83). */
function ExpandAllButton() {
  const t = useTranslations('Coordinator.activity')
  const all = useContext(ActivityExpansionContext)
  if (!all) return null
  const label = all.open ? t('collapseAll') : t('expandAll')
  return <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} data-activity-expand-all={all.open ? 'open' : 'closed'}
    className="text-muted-foreground opacity-0 transition-opacity group-hover/activity:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none" onClick={all.toggle} />}>
    {all.open ? <ChevronsDownUp aria-hidden="true" /> : <ChevronsUpDown aria-hidden="true" />}
  </TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
}

/**
 * Two or more calls with nothing said between them (R-83): one line that says what they did, side effects first
 * (「派发了 1 个线程，查看了 3 次任务 · 1 个失败」), closed; opened, a row per call. While the reply streams it is open
 * on the call running now, and closes when the calls end. The reader's own click, or 全部展开, wins.
 */
function ToolGroup({ tools, live }: { tools: readonly ChatTool[]; live: boolean }) {
  const t = useTranslations('Coordinator.activity')
  const label = useToolLabel()
  const running = live && tools.some(tool => tool.state === 'running')
  const [open, setOpen] = useFollowedOpen(running)
  const { parts, failed } = toolSummary(tools)
  const LeadIcon = ACTION_ICONS[parts[0]?.action ?? 'other']
  const current = running ? [...tools].reverse().find(tool => tool.state === 'running') : undefined
  const shown = parts.slice(0, 3).map(part => t(`summary.${part.action}` as never, { count: part.count } as never))
  const summary = current ? t('running', { tool: label(current.name) }) : `${shown.join(t('separator'))}${parts.length > 3 ? t('more') : ''}`
  // Ended without finishing: a call left running counts as failed.
  const failures = failed + (live ? 0 : tools.filter(tool => tool.state === 'running').length)
  return <TraceCollapsible data-activity-group={running ? 'running' : failures ? 'error' : 'done'} open={open} onOpenChange={setOpen}>
    <div className="group/activity flex min-w-0 items-center gap-1">
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? 'running' : undefined}>
          <TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : failures ? <CircleAlert className="text-destructive" /> : <LeadIcon />}</TraceIcon>
          <TraceTitle>{summary}</TraceTitle>
          {/* The failure count never truncates with the summary: it is what the line must say (R-83, R-87). */}
          {failures > 0 && !running && <span data-activity-failed="" className="shrink-0 rounded-sm bg-destructive/10 px-1 text-destructive">{t('failedCount', { count: failures })}</span>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <ExpandAllButton />
    </div>
    <TraceCollapsibleContent>
      <Trace>{tools.map(tool => <ToolRow key={tool.call} tool={tool} live={live} />)}</Trace>
    </TraceCollapsibleContent>
  </TraceCollapsible>
}

/**
 * What a reply did before its words, as shadcn/ui's Trace: its thinking, then its tools — one row for a single call, a
 * summary line for several (R-83). `thinking` is live only: `active` while the model thinks, else the seconds it took,
 * and what it has thought as it streams when the model returns readable reasoning. A stored reply knows that it
 * thought (`thought`) and which stored rows hold readable reasoning (`reasoningAt`), loaded when the person opens it.
 * `live` while the reply streams.
 */
export const ReplyActivity = memo(function ReplyActivity({ tools, thinking, thought = false, reasoningAt, botId = null, live = false }: {
  tools: readonly ChatTool[]
  thinking?: { active: boolean; seconds: number; text?: string }
  thought?: boolean
  reasoningAt?: readonly number[]
  botId?: string | null
  live?: boolean
}) {
  const t = useTranslations('Coordinator.activity')
  const [opened, setOpened] = useState(false)
  // A stored reply's reasoning is read only once it is opened; the chat's own data keeps just its length.
  const stored = !thinking?.text && reasoningAt?.length ? reasoningAt : null
  const { data: storedText } = useSWR(opened && stored ? ['coordinator-reasoning', botId, ...stored] : null, () => coordinatorReasoning(botId, stored ?? []),
    { revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false })
  if (!tools.length && !thinking && !thought) return null
  const text = thinking?.text ?? (stored ? storedText ?? '' : undefined)
  const title = thinking?.active ? t('thinking') : thinking ? t('thought', { seconds: thinking.seconds }) : t('thoughtStored')
  return <Trace data-reply-activity="">
    {(thinking || thought) && <ThinkingRow running={thinking?.active ?? false} title={title} text={text} onOpen={() => setOpened(true)} />}
    {tools.length === 1 ? <ToolRow tool={tools[0]} live={live} /> : tools.length > 1 && <ToolGroup tools={tools} live={live} />}
  </Trace>
})

/** Before a reply has anything to show: the same Thinking row, running, as the Trace docs start a turn. */
export function ReplyWaiting() {
  const t = useTranslations('Coordinator.activity')
  return <Trace data-reply-waiting=""><ThinkingRow running title={t('thinking')} /></Trace>
}
