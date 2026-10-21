'use client'

import type { Ref } from 'react'
import { PromptInput } from '@/components/agents/prompt-input'
import { Kbd } from '@/components/ui/kbd'

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
    placeholder="描述你想完成的事…"
    maxLength={8000}
    readOnly={isLoading}
    value={draft}
    onValueChange={onChange}
    onSubmit={onSubmit}
    loading={isLoading}
    onStop={onStop}
    leadingAction={<span className="flex items-center gap-1 text-xs text-muted-foreground"><Kbd>Shift</Kbd><span>+</span><Kbd>Enter</Kbd><span>换行</span></span>}
  />
}
