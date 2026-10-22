'use client'

import type { Ref } from 'react'
import { PromptInput } from '@/components/agents/prompt-input'
import { agentStarters } from './agent-starters'

export function AgentComposer({ ref, draft, onChange, onSubmit, isLoading, onStop, isEmpty = false }: {
  ref: Ref<HTMLTextAreaElement>
  isEmpty?: boolean
  draft: string
  onChange: (value: string) => void
  onSubmit: () => void
  isLoading: boolean
  onStop: () => void
}) {
  return <PromptInput
    ref={ref}
    aria-label="向 Agent 提问"
    placeholder={isEmpty ? '向 Agent 提问…' : '输入消息…'}
    minRows={isEmpty ? 2 : 1}
    maxRows={4}
    models={[{ value: 'deepseek-v4.1-flash', label: 'DS 4.1 Flash' }]}
    model="deepseek-v4.1-flash"
    actions={agentStarters.map(starter => ({ value: starter.title, label: starter.title, icon: <starter.icon /> }))}
    onAction={value => {
      const starter = agentStarters.find(item => item.title === value)
      if (starter) {
        onChange(starter.prompt)
        if (ref && typeof ref === 'object') ref.current?.focus()
      }
    }}
    maxLength={8000}
    readOnly={isLoading}
    value={draft}
    onValueChange={onChange}
    onSubmit={onSubmit}
    loading={isLoading}
    onStop={onStop}
  />
}
