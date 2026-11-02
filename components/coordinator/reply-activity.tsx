'use client'

import { memo } from 'react'
import { useTranslations } from 'next-intl'
import { BrainIcon } from 'lucide-react'
import type { ToolUIPart } from 'ai'
import { Reasoning, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Shimmer } from '@/components/ai-elements/shimmer'
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
 * else the seconds it took. A stored reply knows only that it thought (`thought`). Reasoning text is never shown
 * (chat-projection.ts), so Reasoning has no content and does not open. A tool's previews are short and masked.
 */
export const ReplyActivity = memo(function ReplyActivity({ tools, thinking, thought = false }: {
  tools: readonly ChatTool[]
  thinking?: { active: boolean; seconds: number }
  thought?: boolean
}) {
  const t = useTranslations('Coordinator.activity')
  if (!tools.length && !thinking && !thought) return null
  const label = (name: string) => t.has(`tools.${name}` as never) ? t(`tools.${name}` as never) : t('tool')
  return <div data-reply-activity="" className="flex w-full min-w-0 max-w-md flex-col gap-1.5">
    {(thinking || thought) && <Reasoning className="mb-0" isStreaming={thinking?.active ?? false} duration={thinking && !thinking.active ? thinking.seconds : undefined} defaultOpen={false}
      data-activity-thinking={thinking ? thinking.active ? 'active' : 'done' : 'stored'}>
      <ReasoningTrigger disabled className="w-fit text-xs">
        <BrainIcon className="size-3.5" />
        {thinking?.active ? <Shimmer as="span" duration={1}>{t('thinking')}</Shimmer>
          : <span>{thinking ? t('thought', { seconds: thinking.seconds }) : t('thoughtStored')}</span>}
      </ReasoningTrigger>
    </Reasoning>}
    {tools.map(tool => <Tool key={tool.call} className="mb-0" data-activity-tool={tool.state}>
      <ToolHeader className="gap-3 px-3 py-2" title={label(tool.name)} type={`tool-${tool.name}`} state={STATES[tool.state]} />
      {(tool.input || tool.output) && <ToolContent>
        {tool.input && <ToolInput className="p-3 pt-0" input={previewValue(tool.input)} />}
        {tool.output && <ToolOutput className="p-3 pt-0" output={tool.state === 'error' ? undefined : previewValue(tool.output)} errorText={tool.state === 'error' ? tool.output : undefined} />}
      </ToolContent>}
    </Tool>)}
  </div>
})
