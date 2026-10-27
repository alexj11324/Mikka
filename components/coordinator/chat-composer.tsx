'use client'

import { useId, useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowUp, Plus, Square } from 'lucide-react'
import { toast } from 'sonner'
import { TEXT_ATTACHMENT_ACCEPT, textAttachment } from '@/lib/text-attachment'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

const MAX_LENGTH = 10_000

/**
 * The Grok-style composer every chat uses (Coordinator and bots): one rounded
 * bar, attach on the left, send on the right. No model picker: the model is
 * ours unless the person picks their own in settings.
 */
export function ChatComposer({ ref, value, onChange, onSubmit, label, placeholder, sending = false, running = false, onStop, quote }: {
  ref: Ref<HTMLTextAreaElement | null>
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  label: string
  placeholder?: string
  /** Waiting for a reply. With `onStop`, the send button turns into stop. */
  sending?: boolean
  /** The other side keeps working and still takes messages. With `onStop`, the button is stop until something is typed. */
  running?: boolean
  onStop?: () => void
  /** Something quoted into the message (an artifact quote chip): it sits on top, the buttons move to a row below. */
  quote?: ReactNode
}) {
  const t = useTranslations('Coordinator')
  const tShell = useTranslations('Shell')
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const fileId = useId()
  const stoppable = !!onStop && (sending || (running && !value.trim()))
  const setInput = (node: HTMLTextAreaElement | null) => {
    inputRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }

  async function attach(files: File[]) {
    let next = value
    for (const file of files) {
      const block = await textAttachment(file, MAX_LENGTH - next.length - 2)
      if (!block) { toast.error(tShell('attachUnsupported', { max: MAX_LENGTH })); continue }
      next = next.trim() ? `${next.trimEnd()}\n\n${block}` : block
    }
    onChange(next)
    inputRef.current?.focus()
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (!sending && value.trim()) onSubmit()
  }

  return <form onSubmit={event => { event.preventDefault(); if (!sending && value.trim()) onSubmit() }}>
    <FieldGroup className="sr-only"><Field><FieldLabel htmlFor={fileId}>{tShell('attach')}</FieldLabel><Input ref={fileRef} id={fileId} type="file" accept={TEXT_ATTACHMENT_ACCEPT} multiple className="sr-only" tabIndex={-1} onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = '' }} /></Field></FieldGroup>
    <InputGroup className={cn('min-h-12 rounded-3xl bg-background shadow-xs', quote && 'rounded-2xl')}>
      {quote && <InputGroupAddon align="block-start" className="px-2 pt-2 pb-0">{quote}</InputGroupAddon>}
      {!quote && <InputGroupAddon align="inline-start" className="self-end pb-2">
        <InputGroupButton type="button" variant="secondary" size="icon-sm" className="rounded-full" aria-label={tShell('attach')} disabled={sending} onClick={() => fileRef.current?.click()}><Plus /></InputGroupButton>
      </InputGroupAddon>}
      <InputGroupTextarea ref={setInput} aria-label={label} placeholder={placeholder ?? label} className={cn('max-h-48 py-3.5', quote ? 'min-h-10 pb-1' : 'min-h-12')} value={value} maxLength={MAX_LENGTH} rows={1} disabled={sending && !onStop} onChange={event => onChange(event.target.value)} onKeyDown={onKeyDown} />
      <InputGroupAddon align={quote ? 'block-end' : 'inline-end'} className={cn(quote ? 'justify-between px-2 pt-0 pb-2' : 'self-end pb-2')}>
        {quote && <InputGroupButton type="button" variant="secondary" size="icon-sm" className="rounded-full" aria-label={tShell('attach')} disabled={sending} onClick={() => fileRef.current?.click()}><Plus /></InputGroupButton>}
        {stoppable
          ? <InputGroupButton type="button" variant="default" size="icon-sm" className="rounded-full" aria-label={t('stop')} onClick={onStop}><Square className="fill-current" /></InputGroupButton>
          : <InputGroupButton type="submit" variant="default" size="icon-sm" className="rounded-full" aria-label={t('send')} disabled={sending || !value.trim()}>{sending ? <Spinner /> : <ArrowUp />}</InputGroupButton>}
      </InputGroupAddon>
    </InputGroup>
  </form>
}
