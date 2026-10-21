'use client'

import type { Ref } from 'react'
import { PromptInput } from '@/components/agents/prompt-input'
import { agentStarters } from './agent-starters'

export function AgentComposer({ ref, draft, onChange, onSubmit, isLoading, onStop }: {
  ref: Ref<HTMLTextAreaElement>
  draft: string
  onChange: (value: string) => void
  onSubmit: () => void
  isLoading: boolean
  onStop: () => void
}) {
  return <PromptInput
    ref={ref}
    aria-label="向 Agent 提问"
    aria-describedby="agent-service-note"
    placeholder="让 Agent 继续…"
    minRows={1}
    maxRows={4}
    models={[{ value: 'glm-5.3-flash', label: 'GLM-5.3-Flash' }]}
    model="glm-5.3-flash"
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
