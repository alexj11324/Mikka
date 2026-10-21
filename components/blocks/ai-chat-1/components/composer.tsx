'use client'

import type { Ref } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Frame, FramePanel } from '@/components/reui/frame'
import { FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'

export function Composer({ ref, draft, onChange, onSubmit, isLoading, onStop }: {
  ref: Ref<HTMLTextAreaElement>
  draft: string
  onChange: (value: string) => void
  onSubmit: () => void
  isLoading: boolean
  onStop: () => void
}) {
  return <Frame dense spacing="sm" className="w-full">
    <FramePanel className="p-0">
      <form aria-label="Agent 输入" onSubmit={event => { event.preventDefault(); onSubmit() }}>
        <FieldLabel htmlFor="agent-composer" className="sr-only">向 Agent 提问</FieldLabel>
        <InputGroup className="border-0">
          <InputGroupTextarea id="agent-composer" ref={ref} aria-describedby="agent-service-note" placeholder="描述你想完成的事…" rows={2} maxLength={8000} readOnly={isLoading} value={draft} className="max-h-48 min-h-20" onChange={event => onChange(event.target.value)} onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSubmit() }
          }} />
          <InputGroupAddon align="block-end" className="justify-between gap-3">
            <span className="flex items-center gap-1 text-xs"><Kbd>Shift</Kbd><span>+</span><Kbd>Enter</Kbd><span>换行</span></span>
            {isLoading
              ? <InputGroupButton type="button" size="icon-sm" variant="outline" onClick={onStop} aria-label="停止生成"><Square aria-hidden="true" /></InputGroupButton>
              : <InputGroupButton type="submit" size="icon-sm" variant="default" disabled={!draft.trim()} aria-label="发送消息"><ArrowUp aria-hidden="true" /></InputGroupButton>}
          </InputGroupAddon>
        </InputGroup>
      </form>
    </FramePanel>
  </Frame>
}
