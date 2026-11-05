'use client'

import { createContext, memo, useCallback, useContext, useMemo, useState, type ComponentType } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import {
  BellRing, BookOpen, Brain, CalendarDays, ChevronsDownUp, ChevronsUpDown, CircleAlert, CircleCheckIcon, CircleStop, Factory, FolderGit2, Power, FolderOpen, Globe, ListChecks,
  LoaderCircleIcon, Mail, MessageSquare, MessageSquareText, Pencil, Search, Send, SquarePlus, Wrench,
} from 'lucide-react'
import { coordinatorReasoning } from '@/app/actions/coordinator'
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/reui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GitHubIcon } from '@/components/icons/brand-icons'
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'
import { toolAction, toolFailure, toolObjectId, toolSummary, toolTarget, type ToolAction } from '@/lib/coordinator/tool-activity'
import { CitationChip, useAgentCitations } from '@/components/workspace/agent-citations'
import { threadGroupOfRun } from '@/components/workspace/thread-status-icon'
import { HarnessLabel } from '@/components/labels/entity-labels'
import { toolDetail, type ToolDetailLine } from '@/lib/coordinator/tool-detail'
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
  dispatch: Send, dispatchFactory: Factory, wake: Power, messageThread: MessageSquareText, stopThread: CircleStop, createIssue: SquarePlus, updateIssue: Pencil,
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
  if (!(tool.input || tool.output) || running) return <div data-activity-tool={running ? 'running' : failed ? 'error' : 'done'}>{line}</div>
  return <TraceCollapsible data-activity-tool={failed ? 'error' : 'done'}>
    <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
    <TraceCollapsibleContent className="flex flex-col gap-2">
      <ToolDetail tool={tool} failed={failed} />
      <RawData tool={tool} failed={failed} />
    </TraceCollapsibleContent>
  </TraceCollapsible>
}

/**
 * An opened call in words (R-83): what it was asked, what it acted on or made, what came back. A dispatch reads
 * 「交给 Claude Code」 and its thread's chip, then its note as a quote. Ids never show. A failed call shows nothing
 * here: its row names the reason, and what it was asked never happened.
 */
function ToolDetail({ tool, failed }: { tool: ChatTool; failed: boolean }) {
  const lines = toolDetail(tool, failed)
  if (!lines.length) return null
  return <div data-activity-detail="" className="flex min-w-0 flex-col gap-1.5 text-sm text-foreground">
    {lines.map((line, index) => <ToolDetailRow key={index} line={line} />)}
  </div>
}

function ToolDetailRow({ line }: { line: ToolDetailLine }) {
  const t = useTranslations('Coordinator.activity.detail')
  const tIssue = useTranslations('Issue.status')
  const source = useAgentCitations()?.sources[line.kind === 'object' ? line.id : '']
  if (line.kind === 'handoff') return <Handoff line={line} />
  if (line.kind === 'quote') return <Quote text={line.text} />
  // A task or thread chip; a thread's chip shows its own state where it needs the reader (R-15).
  if (line.kind === 'object') return source ? <span className="flex min-w-0 flex-wrap items-center gap-1.5"><CitationChip id={line.id} kind={source.kind} /></span> : null
  if (line.kind === 'field') return <span className="flex min-w-0 gap-2">
    <span className="shrink-0 text-muted-foreground">{t(line.label as never)}</span>
    <span className="min-w-0 truncate">{line.label === 'count' ? t('countValue', { count: Number(line.value) })
      : line.label === 'status' && tIssue.has(String(line.value) as never) ? tIssue(String(line.value) as never) : line.value}</span>
  </span>
  return <span className="flex min-w-0 gap-2"><span className="shrink-0 text-muted-foreground">{line.key}</span><span className="min-w-0 truncate">{line.value}</span></span>
}

/**
 * Who a dispatch went to: 「交给」, the coding agent with its mark (R-74), then the thread's chip. A thread the chat has
 * not loaded is its state in words, as the thread list groups it (R-52): 「交给 Claude Code · 进行中」.
 */
function Handoff({ line }: { line: Extract<ToolDetailLine, { kind: 'handoff' }> }) {
  const t = useTranslations('Coordinator.activity.detail')
  const tState = useTranslations('Shell.threads.state')
  const found = useAgentCitations()?.sources[line.runId ?? '']
  const thread = found?.kind === 'run' ? found : null
  const harness = thread?.harness ?? line.harness
  const status = thread ? null : line.status
  return <span data-activity-thread="" className="flex min-w-0 flex-wrap items-center gap-1.5">
    {harness ? <span className="flex items-center gap-1.5 text-muted-foreground">{t('handedTo')}<HarnessLabel harness={harness} /></span>
      : <span className="text-muted-foreground">{t('dispatched')}</span>}
    {thread && <CitationChip id={thread.id} kind="run" />}
    {status && <span className="text-muted-foreground">· {tState(threadGroupOfRun(status))}</span>}
  </span>
}

/** A call's words as a quote: three lines, and only when they are cut is it a button that opens the rest. */
function Quote({ text }: { text: string }) {
  const [whole, setWhole] = useState(false)
  const [cut, setCut] = useState(false)
  // Measured again whenever the quote's width changes (a resized column, a rotated phone), not only once.
  const measure = useCallback((node: HTMLSpanElement | null) => {
    if (!node) return
    const check = () => setCut(node.scrollHeight > node.clientHeight + 1)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const words = <span ref={whole ? undefined : measure} className={cn('min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap', !whole && 'line-clamp-3')}>{text}</span>
  const quote = 'border-l-2 border-l-muted-foreground/30 pl-2.5 text-left text-muted-foreground'
  if (!cut) return <div data-activity-quote="" className={quote}>{words}</div>
  return <Button variant="ghost" data-activity-quote="" aria-expanded={whole} onClick={() => setWhole(!whole)}
    className={cn('h-auto justify-start rounded-none border-0 py-0 pr-0 font-normal hover:bg-transparent hover:text-muted-foreground', quote)}>{words}</Button>
}

/** The call's raw input and output, folded under 「原始数据」, one more click away (R-83). */
function RawData({ tool, failed }: { tool: ChatTool; failed: boolean }) {
  const t = useTranslations('Coordinator.activity.detail')
  return <TraceCollapsible data-activity-raw="">
    <TraceCollapsibleTrigger><TraceLine><TraceTitle>{t('raw')}</TraceTitle></TraceLine></TraceCollapsibleTrigger>
    <TraceCollapsibleContent className="flex flex-col gap-2">
      {tool.input && <CodeBlock size="sm"><CodeBlockContent wrap className="max-h-40">{tool.input}</CodeBlockContent></CodeBlock>}
      {tool.output && <CodeBlock size="sm" {...(failed ? { variant: 'destructive' as const } : {})}><CodeBlockContent wrap className="max-h-64">{tool.output}</CodeBlockContent></CodeBlock>}
    </TraceCollapsibleContent>
  </TraceCollapsible>
}

/** 全部展开 / 全部收起, always shown at the end of a group's summary; it opens or closes every group in the chat (R-83). */
function ExpandAllButton() {
  const t = useTranslations('Coordinator.activity')
  const all = useContext(ActivityExpansionContext)
  if (!all) return null
  const label = all.open ? t('collapseAll') : t('expandAll')
  return <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} data-activity-expand-all={all.open ? 'open' : 'closed'}
    className="text-muted-foreground" onClick={all.toggle} />}>
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
  const { parts, failed, failedNames } = toolSummary(tools)
  const LeadIcon = ACTION_ICONS[parts[0]?.action ?? 'other']
  // Calls left running when the reply ended never finished: they failed too.
  const unfinished = live ? [] : tools.filter(tool => tool.state === 'running')
  const failedLabels = [...new Set([...failedNames, ...unfinished.map(tool => tool.name)])].map(label)
  const current = running ? [...tools].reverse().find(tool => tool.state === 'running') : undefined
  const shown = parts.slice(0, 3).map(part => t(`summary.${part.action}` as never, { count: part.count } as never))
  // Only what succeeded is said as done; when nothing did, the line names the calls that failed (R-83).
  const summary = current ? t('running', { tool: label(current.name) })
    : shown.length ? `${shown.join(t('separator'))}${parts.length > 3 ? t('more') : ''}` : failedLabels.join(t('separator'))
  // Ended without finishing: a call left running counts as failed.
  const failures = failed + unfinished.length
  return <TraceCollapsible data-activity-group={running ? 'running' : failures ? 'error' : 'done'} open={open} onOpenChange={setOpen}>
    <div className="group/activity flex min-w-0 items-center gap-1">
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? 'running' : undefined}>
          <TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : failures ? <CircleAlert className="text-destructive" /> : <LeadIcon />}</TraceIcon>
          <TraceTitle>{summary}</TraceTitle>
          {/* The failure count never truncates with the summary: it is what the line must say (R-83, R-87). */}
          {failures > 0 && !running && <Badge data-activity-failed="" variant="destructive-light" size="sm" className="shrink-0">{t('failedCount', { count: failures })}</Badge>}
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
