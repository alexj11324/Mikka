'use client'

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowUp, Plus, Square } from 'lucide-react'
import { toast } from 'sonner'
import { TEXT_ATTACHMENT_ACCEPT, textAttachment } from '@/lib/text-attachment'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { MESSAGE_MAX } from '@/lib/message-limits'
import { sendsMessage, type SendKey } from '@/lib/send-key'

const MAX_LENGTH = MESSAGE_MAX

/**
 * A card, not a form field (R-31 keeps fields fill-only): a 1px `--rule` line
 * that stays dark grey in dark mode, a soft shadow, and a darker line on focus,
 * as Codex and Linear draw their composers. The text sits above a button row.
 */
// Empty, focused and typing look the same: the 1px rule and a soft shadow. Focus only deepens the
// shadow (Codex); it never draws a dark outline (Alex 2026-10-31).
const COMPOSER = 'rounded-2xl border border-rule bg-card shadow-sm transition-shadow has-[[data-slot=input-group-control]:focus-visible]:shadow-md has-[[data-slot=input-group-control]:focus-visible]:ring-0'

/** A send arrow with nothing to send is a solid grey control, not a faded black one. */
const SEND_DISABLED = 'disabled:bg-control disabled:text-muted-foreground disabled:opacity-100'

/**
 * The Grok-style composer every chat uses (Coordinator and bots): one rounded
 * bar, attach on the left, send on the right. No model picker: the model is
 * ours unless the person picks their own in settings.
 */
export function ChatComposer({ ref, value, onChange, onSubmit, label, placeholder, sending = false, running = false, editableWhileSending = false, submitDisabled = false, onStop, quote, sendKey = 'enter' }: {
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
  /** Keep the draft editable while a thread waits for its stop acknowledgement. */
  editableWhileSending?: boolean
  /** The draft remains editable, but the run no longer accepts new messages. */
  submitDisabled?: boolean
  onStop?: () => void
  /** Something quoted into the message (an artifact quote chip): it sits on top, the buttons move to a row below. */
  quote?: ReactNode
  /** The person's send key (偏好设置); the caller reads it from their preferences. */
  sendKey?: SendKey
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

  // Textarea already has `field-sizing-content`; browsers without it get the same
  // one-line-to-max-h-48 growth from scrollHeight, so the draft never scrolls sideways.
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')) return
    input.style.height = 'auto'
    const max = Number.parseFloat(getComputedStyle(input).maxHeight)
    const height = Number.isFinite(max) ? Math.min(input.scrollHeight, max) : input.scrollHeight
    input.style.height = `${height}px`
    input.style.overflowX = 'hidden'
    input.style.overflowY = input.scrollHeight > height ? 'auto' : 'hidden'
  }, [value])

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
    const { key, shiftKey, metaKey, ctrlKey } = event
    if (!sendsMessage({ key, shiftKey, metaKey, ctrlKey, isComposing: event.nativeEvent.isComposing }, sendKey)) return
    event.preventDefault()
    if (!sending && !submitDisabled && value.trim()) onSubmit()
  }

  return <form onSubmit={event => { event.preventDefault(); if (!sending && !submitDisabled && value.trim()) onSubmit() }}>
    <FieldGroup className="sr-only w-px"><Field><FieldLabel htmlFor={fileId}>{tShell('attach')}</FieldLabel><Input ref={fileRef} id={fileId} type="file" accept={TEXT_ATTACHMENT_ACCEPT} multiple className="sr-only" tabIndex={-1} onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = '' }} /></Field></FieldGroup>
    <InputGroup className={COMPOSER}>
      {quote && <InputGroupAddon align="block-start" className="px-2 pt-2 pb-0">{quote}</InputGroupAddon>}
      {/* readOnly, not disabled: a disabled field drops focus, so the next key went to page shortcuts. */}
      <InputGroupTextarea ref={setInput} aria-label={label} placeholder={placeholder ?? label} className={cn('max-h-48 min-w-0 overflow-x-hidden px-3.5 pt-3 pb-1 wrap-break-word', quote ? 'min-h-10' : 'min-h-14')} value={value} maxLength={MAX_LENGTH} rows={2} readOnly={sending && !onStop && !editableWhileSending} aria-busy={sending || undefined} onChange={event => onChange(event.target.value)} onKeyDown={onKeyDown} />
      <InputGroupAddon align="block-end" className="justify-between px-2 pt-0 pb-2">
        <InputGroupButton type="button" variant="secondary" size="icon-sm" className="rounded-full" aria-label={tShell('attach')} disabled={sending} onClick={() => fileRef.current?.click()}><Plus /></InputGroupButton>
        {stoppable
          ? <InputGroupButton type="button" variant="default" size="icon-sm" className="rounded-full" aria-label={t('stop')} onClick={onStop}><Square className="fill-current" /></InputGroupButton>
          : <InputGroupButton type="submit" variant="default" size="icon-sm" className={cn('rounded-full', SEND_DISABLED)} aria-label={t('send')} disabled={sending || submitDisabled || !value.trim()}>{sending ? <Spinner /> : <ArrowUp />}</InputGroupButton>}
      </InputGroupAddon>
    </InputGroup>
    {/* The limit is shown only when it is close enough to matter. */}
    {value.length > MAX_LENGTH - 500 && <p role="status" aria-live="polite" className="px-3 pb-1 text-right text-xs text-muted-foreground">{t('lengthCount', { count: value.length, max: MAX_LENGTH })}</p>}
  </form>
}
