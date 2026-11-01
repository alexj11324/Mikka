'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { AgentTextBubble } from './agent-text-bubble'
import { useIsStreaming } from '@openuidev/react-lang'
import { Bot, CircleCheck, CircleHelp, Code, ListTodo, LoaderCircle, MessageSquareText, Quote } from 'lucide-react'
import { StreamingResponse } from '@/components/agents/streaming-response'
import { AgentMarkdown } from './agent-markdown'
import { AgentCodeBlock } from './agent-code-block'
import { TodoList } from '@/components/agents/todo-list'
import type { AgentComponentRenderers } from '@/lib/agent-ui-catalog'

export const AgentCodeContent: AgentComponentRenderers['BeCodeBlock'] = ({ props }) => {
  const isStreaming = useIsStreaming()
  return <AgentCodeBlock {...props} isStreaming={isStreaming} />
}

const icons = { assistant: Bot, reply: MessageSquareText, approve: CircleCheck, question: CircleHelp, progress: LoaderCircle, task: ListTodo, code: Code, source: Quote }

export const AgentTextContent: AgentComponentRenderers['TextContent'] = ({ props }) => {
  const isStreaming = useIsStreaming()
  return <AgentTextBubble><AgentMarkdown text={props.text ?? ''} size={props.size} isStreaming={isStreaming} /></AgentTextBubble>
}

export const AgentContent: AgentComponentRenderers['BeResponse'] = ({ props, renderNode }) => {
  const streaming = useIsStreaming()
  // Each TextContent spaces its own blocks (gap-3); StreamingResponse's prose margins on lists stacked on top of that (~64px between one-line lists).
  return <StreamingResponse status={streaming ? 'streaming' : 'complete'} announce={false} showActions={false} contentClassName="[&_ol]:my-0 [&_ul]:my-0">
    <div className="flex min-w-0 flex-col gap-3">{renderNode(props.children)}</div>
  </StreamingResponse>
}

export const AgentTasks: AgentComponentRenderers['BeTodoList'] = ({ props }) => {
  const agentCopy = useAgentCopy()

  const suggested = props.source !== 'user'
  const items = (props.items ?? []).map(item => suggested ? { id: item.id, title: item.title, status: 'pending' as const, detail: item.detail } : item)
  return <div className="flex min-w-0 flex-col gap-2">
    {suggested && <p className="text-xs text-muted-foreground">{agentCopy.suggestedPlanNotExecutedOrSaved}</p>}
    <TodoList title={props.title} items={items} collapseOnComplete={false} />
  </div>
}

export const AgentStatusIcon: AgentComponentRenderers['AgentIcon'] = ({ props }) => {
  const Icon = icons[props.name]
  if (!Icon) return null
  return <span className="inline-flex items-center gap-2 text-sm"><Icon aria-hidden="true" className="size-4 shrink-0" />{props.label}</span>
}
