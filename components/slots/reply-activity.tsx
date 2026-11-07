'use client'

// The default reply-activity slot (docs/ui-overlay.md): thinking and tool calls as shadcn/ui's Trace draws them.
import { useState, type ReactNode } from 'react'
import { CircleAlert, CircleCheckIcon, LoaderCircleIcon } from 'lucide-react'
import { Badge } from '@/components/reui/badge'
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'
import type { ActivityGroupProps, ActivityThinkingProps, ActivityToolView } from '@/components/slots/reply-activity-contract'
import { cn } from '@/lib/utils'

/** The rows of one reply's activity, or the wait before a reply. */
export function ActivityList({ children, ...data }: { children: ReactNode; 'data-reply-activity'?: string; 'data-reply-waiting'?: string }) {
  return <Trace {...data}>{children}</Trace>
}

/**
 * Thinking as shadcn/ui's Trace draws it (ui.shadcn.com/docs/components/base/trace, its Reasoning row): "Thinking"
 * with a spinner while the model thinks, open as the words stream in; "Thought for N seconds" with a check once it
 * stops, closed. A reader's own click wins either way. Without readable reasoning it is a line that does not open.
 */
export function ActivityThinking({ running, title, text, onOpen }: ActivityThinkingProps) {
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

export function ActivityTool({ tool }: { tool: ActivityToolView }) {
  const running = tool.state === 'running'
  const failed = tool.state === 'error'
  const line = <TraceLine status={running ? 'running' : failed ? 'error' : undefined}>
    <TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : failed ? <CircleAlert /> : tool.icon}</TraceIcon>
    <TraceTitle>
      {tool.title}
      {tool.target && <span className={cn('ml-1.5', !failed && 'text-muted-foreground/70')}>{tool.target}</span>}
      {tool.why && <span className="ml-1.5">· {tool.why}</span>}
    </TraceTitle>
  </TraceLine>
  if (!tool.openable) return <div data-activity-tool={tool.state}>{line}</div>
  return <TraceCollapsible data-activity-tool={tool.state}>
    <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
    <TraceCollapsibleContent className="flex flex-col gap-2">
      {tool.details}
      {tool.raw}
    </TraceCollapsibleContent>
  </TraceCollapsible>
}

export function ActivityGroup({ tools, running, summary, failures, failuresLabel, leadIcon, open, onOpenChange, expandAll }: ActivityGroupProps) {
  return <TraceCollapsible data-activity-group={running ? 'running' : failures ? 'error' : 'done'} open={open} onOpenChange={onOpenChange}>
    <div className="group/activity flex min-w-0 items-center gap-1">
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? 'running' : undefined}>
          <TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : failures ? <CircleAlert className="text-destructive-foreground" /> : leadIcon}</TraceIcon>
          <TraceTitle>{summary}</TraceTitle>
          {/* The failure count never truncates with the summary: it is what the line must say (R-83, R-87). */}
          {failures > 0 && !running && <Badge data-activity-failed="" variant="destructive-light" size="sm" className="shrink-0">{failuresLabel}</Badge>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      {expandAll}
    </div>
    <TraceCollapsibleContent>
      <Trace>{tools.map(tool => <ActivityTool key={tool.key} tool={tool} />)}</Trace>
    </TraceCollapsibleContent>
  </TraceCollapsible>
}
