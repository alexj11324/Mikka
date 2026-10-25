'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { useId, useRef, type Ref } from 'react'
import { useTranslations } from 'next-intl'
import { Paperclip } from 'lucide-react'
import { toast } from 'sonner'
import { PromptInput } from '@/components/agents/prompt-input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { TEXT_ATTACHMENT_ACCEPT, textAttachment } from '@/lib/text-attachment'
import { getAgentStarters } from './agent-starters'

const MAX_LENGTH = 8000
const ATTACH = 'attach-file'

export function AgentComposer({ ref, draft, onChange, onSubmit, isLoading, onStop, isEmpty = false }: {
  ref: Ref<HTMLTextAreaElement>
  isEmpty?: boolean
  draft: string
  onChange: (value: string) => void
  onSubmit: () => void
  isLoading: boolean
  onStop: () => void
}) {
  const agentCopy = useAgentCopy()
  const tShell = useTranslations('Shell')
  const agentStarters = getAgentStarters(agentCopy)
  const fileRef = useRef<HTMLInputElement>(null)
  const fileId = useId()
  const focus = () => { if (ref && typeof ref === 'object') ref.current?.focus() }

  async function attach(files: File[]) {
    let next = draft
    for (const file of files) {
      const block = await textAttachment(file, MAX_LENGTH - next.length - 2)
      if (!block) { toast.error(tShell('attachUnsupported', { max: MAX_LENGTH })); continue }
      next = next.trim() ? `${next.trimEnd()}\n\n${block}` : block
    }
    onChange(next)
    focus()
  }

  return <>
    <FieldGroup className="sr-only"><Field><FieldLabel htmlFor={fileId}>{tShell('attach')}</FieldLabel><Input ref={fileRef} id={fileId} type="file" accept={TEXT_ATTACHMENT_ACCEPT} multiple className="sr-only" tabIndex={-1} onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = '' }} /></Field></FieldGroup>
    <PromptInput
      ref={ref}
      aria-label={agentCopy.askAgent}
      placeholder={isEmpty ? agentCopy.askAgent2 : agentCopy.enterAMessage}
      minRows={isEmpty ? 2 : 1}
      maxRows={4}
      // The + menu opens with 添加文件 (Grok-style), then the starters.
      actions={[{ value: ATTACH, label: tShell('attach'), icon: <Paperclip /> }, ...agentStarters.map(starter => ({ value: starter.title, label: starter.title, icon: <starter.icon /> }))]}
      onAction={value => {
        if (value === ATTACH) { fileRef.current?.click(); return }
        const starter = agentStarters.find(item => item.title === value)
        if (starter) {
          onChange(starter.prompt)
          focus()
        }
      }}
      maxLength={MAX_LENGTH}
      readOnly={isLoading}
      value={draft}
      onValueChange={onChange}
      onSubmit={onSubmit}
      loading={isLoading}
      onStop={onStop}
    />
  </>
}
