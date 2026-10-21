'use client'

import type { Ref } from 'react'
import { ArrowUp } from 'lucide-react'
import { Button } from '@openuidev/react-ui/Button'
import { Card as OpenUICard } from '@openuidev/react-ui/Card'
import { TextArea } from '@openuidev/react-ui/TextArea'

export function AgentComposer({ ref, draft, onChange, onSubmit, isLoading, onStop }: {
  ref: Ref<HTMLTextAreaElement>
  draft: string
  onChange: (value: string) => void
  onSubmit: () => void
  isLoading: boolean
  onStop: () => void
}) {
  return <OpenUICard variant="sunk" width="full">
    <form aria-label="Agent 输入" className="flex min-w-0 flex-col gap-3" onSubmit={event => { event.preventDefault(); onSubmit() }}>
      <TextArea
        ref={ref}
        aria-label="向 Agent 提问"
        aria-describedby="agent-service-note"
        placeholder="描述你想完成的事…"
        rows={3}
        maxLength={8000}
        readOnly={isLoading}
        value={draft}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSubmit() }
        }}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Shift + Enter 换行</span>
        {isLoading
          ? <Button type="button" size="small" variant="secondary" onClick={onStop} aria-label="停止生成">停止</Button>
          : <Button type="submit" size="small" disabled={!draft.trim()} iconLeft={<ArrowUp data-icon="inline-start" aria-hidden="true" />} aria-label="发送消息">发送</Button>}
      </div>
    </form>
  </OpenUICard>
}
