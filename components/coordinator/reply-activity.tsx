'use client'

import { memo, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon } from 'lucide-react'
import { coordinatorReasoning } from '@/app/actions/coordinator'
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block'
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'
import type { ChatTool } from '@/lib/coordinator/context'

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

/**
 * A tool as the Trace docs' Tool row draws it: running with a spinner while the reply streams; done with a check,
 * opening to its output; failed in red, opening to its error. Our output is the short masked preview the stream
 * and the stored chat keep; a tool with nothing to show stays a line.
 */
function ToolRow({ tool, live }: { tool: ChatTool; live: boolean }) {
  const t = useTranslations('Coordinator.activity')
  const label = t.has(`tools.${tool.name}` as never) ? t(`tools.${tool.name}` as never) : t('tool')
  if (tool.state === 'running') {
    return <div data-activity-tool={live ? 'running' : 'error'}><TraceLine status={live ? 'running' : 'error'}>
      <TraceIcon>{live ? <LoaderCircleIcon className="animate-spin" /> : <CircleAlertIcon />}</TraceIcon>
      <TraceTitle>{live ? t('running', { tool: label }) : t('failed', { tool: label })}</TraceTitle>
    </TraceLine></div>
  }
  const failed = tool.state === 'error'
  const line = <TraceLine status={failed ? 'error' : undefined}>
    <TraceIcon>{failed ? <CircleAlertIcon /> : <CircleCheckIcon />}</TraceIcon>
    <TraceTitle>{failed ? t('failed', { tool: label }) : label}</TraceTitle>
  </TraceLine>
  if (!tool.output) return <div data-activity-tool={tool.state}>{line}</div>
  return <TraceCollapsible data-activity-tool={tool.state}>
    <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
    <TraceCollapsibleContent>
      <CodeBlock size="sm" {...(failed ? { variant: 'destructive' as const } : {})}>
        <CodeBlockContent wrap className="max-h-64">{tool.output}</CodeBlockContent>
      </CodeBlock>
    </TraceCollapsibleContent>
  </TraceCollapsible>
}

/**
 * What a reply did before its words, as shadcn/ui's Trace: its thinking, then a row per tool it used. `thinking` is
 * live only: `active` while the model thinks, else the seconds it took, and what it has thought as it streams when
 * the model returns readable reasoning. A stored reply knows that it thought (`thought`) and which stored rows hold
 * readable reasoning (`reasoningAt`), loaded when the person opens it. `live` while the reply streams.
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
    {tools.map(tool => <ToolRow key={tool.call} tool={tool} live={live} />)}
  </Trace>
})

/** Before a reply has anything to show: the same Thinking row, running, as the Trace docs start a turn. */
export function ReplyWaiting() {
  const t = useTranslations('Coordinator.activity')
  return <Trace data-reply-waiting=""><ThinkingRow running title={t('thinking')} /></Trace>
}
