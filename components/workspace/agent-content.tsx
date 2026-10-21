'use client'

import { useIsStreaming } from '@openuidev/react-lang'
import { CircleCheck, CircleHelp, Code, ListTodo, LoaderCircle, MessageSquareText, Quote, Sparkles } from 'lucide-react'
import { StreamingResponse } from '@/components/agents/streaming-response'
import { TodoList } from '@/components/agents/todo-list'
import type { AgentComponentRenderers } from '@/lib/agent-ui-catalog'

const icons = { assistant: Sparkles, reply: MessageSquareText, approve: CircleCheck, question: CircleHelp, progress: LoaderCircle, task: ListTodo, code: Code, source: Quote }

export const AgentContent: AgentComponentRenderers['BeResponse'] = ({ props, renderNode }) => {
  const streaming = useIsStreaming()
  return <StreamingResponse status={streaming ? 'streaming' : 'complete'} announce={false} showActions={false}>
    <div className="flex min-w-0 flex-col gap-3">{renderNode(props.children)}</div>
  </StreamingResponse>
}

export const AgentTasks: AgentComponentRenderers['BeTodoList'] = ({ props }) => {
  const suggested = props.source !== 'user'
  const items = (props.items ?? []).map(item => suggested ? { id: item.id, title: item.title, status: 'pending' as const, detail: item.detail } : item)
  return <div className="flex min-w-0 flex-col gap-2">
    <p className="text-xs text-muted-foreground">{suggested ? '建议计划，尚未执行或保存。' : '仅展示本次提问中用户提供的任务状态。'}</p>
    <TodoList title={props.title} items={items} collapseOnComplete={false} />
  </div>
}

export const AgentStatusIcon: AgentComponentRenderers['AgentIcon'] = ({ props }) => {
  const Icon = icons[props.name]
  if (!Icon) return null
  return <span className="inline-flex items-center gap-2 text-sm"><Icon aria-hidden="true" className="size-4 shrink-0" />{props.label}</span>
}
