'use client'

import { memo, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { BrainIcon } from 'lucide-react'
import type { ToolUIPart } from 'ai'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { coordinatorReasoning } from '@/app/actions/coordinator'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import type { ChatTool } from '@/lib/coordinator/context'

/** Our tool states as the AI SDK's, which AI Elements draws: a call we stream is complete, so it runs until its result. */
const STATES: Record<ChatTool['state'], ToolUIPart['state']> = { running: 'input-available', done: 'output-available', error: 'output-error' }

/** A preview as AI Elements shows it: parsed when it is whole JSON, else the text as it is (it may be cut at 200 characters). */
function previewValue(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}

/**
 * What a reply did before its words, in order, drawn with AI Elements (components/ai-elements, registry.ai-sdk.dev):
 * Reasoning for its thinking, then a Tool per tool it used. `thinking` is live only: `active` while the model thinks,
 * else the seconds it took, and what it thought when the model returned readable reasoning. While it thinks, the
 * Thinking Loader under the chat says so (reply-wait.tsx), so the line here shows once thinking ends. A stored reply knows that
 * it thought (`thought`) and which stored rows hold readable reasoning (`reasoningAt`), loaded when the person opens it.
 * Without readable reasoning, Reasoning has no content and does not open. A tool's previews are short and masked.
 * Thinking and tools are muted lines, not cards; an opened preview is as wide as the reply's text bubble may be (82%),
 * full width on a phone, so it lines up with the reply under it instead of sitting in a narrower fixed box.
 */
export const ReplyActivity = memo(function ReplyActivity({ tools, thinking, thought = false, reasoningAt, botId = null }: {
  tools: readonly ChatTool[]
  thinking?: { active: boolean; seconds: number; text?: string }
  thought?: boolean
  reasoningAt?: readonly number[]
  botId?: string | null
}) {
  const t = useTranslations('Coordinator.activity')
  const [open, setOpen] = useState(false)
  // A stored reply's reasoning is read only once it is opened; the chat's own data keeps just its length.
  const stored = !thinking?.text && reasoningAt?.length ? reasoningAt : null
  const { data: storedText } = useSWR(open && stored ? ['coordinator-reasoning', botId, ...stored] : null, () => coordinatorReasoning(botId, stored ?? []),
    { revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false })
  const thinks = thinking ? !thinking.active : thought
  if (!tools.length && !thinks) return null
  const text = thinking?.text ?? storedText ?? undefined
  const readable = Boolean(thinking?.text || stored)
  const message = <span>{thinking ? t('thought', { seconds: thinking.seconds }) : t('thoughtStored')}</span>
  const label = (name: string) => t.has(`tools.${name}` as never) ? t(`tools.${name}` as never) : t('tool')
  return <div data-reply-activity="" className="flex w-full min-w-0 flex-col gap-1.5 sm:max-w-[82%]">
    {thinks && <Reasoning className="mb-0" isStreaming={false} duration={thinking?.seconds}
      defaultOpen={false} open={readable && open} onOpenChange={setOpen}
      data-activity-thinking={thinking ? 'done' : 'stored'} data-reasoning={readable ? 'readable' : 'none'}>
      {readable
        // AI Elements' own trigger, with its chevron: 「思考了 N 秒」 opens what the model thought.
        ? <ReasoningTrigger className="w-fit text-xs" getThinkingMessage={() => message} />
        // Nothing readable (encrypted or no reasoning): the same line, no chevron, and it does not open.
        : <ReasoningTrigger disabled className="w-fit text-xs"><BrainIcon className="size-3.5" />{message}</ReasoningTrigger>}
      {readable && <ReasoningContent className="mt-2 max-h-80 overflow-y-auto border-l border-border pl-3 text-xs whitespace-pre-wrap">{text ?? ''}</ReasoningContent>}
    </Reasoning>}
    {tools.map(tool => <Tool key={tool.call} data-activity-tool={tool.state}>
      <ToolHeader disabled={!tool.input && !tool.output} title={label(tool.name)} type={`tool-${tool.name}`} state={STATES[tool.state]} />
      {(tool.input || tool.output) && <ToolContent>
        {tool.input && <ToolInput input={previewValue(tool.input)} />}
        {tool.output && <ToolOutput output={tool.state === 'error' ? undefined : previewValue(tool.output)} errorText={tool.state === 'error' ? tool.output : undefined} />}
      </ToolContent>}
    </Tool>)}
  </div>
})
