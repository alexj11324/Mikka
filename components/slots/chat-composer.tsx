'use client'

// The default chat-composer slot (docs/ui-overlay.md): the Grok-style composer every chat uses.
import { useTranslations } from 'next-intl'
import { ArrowUp, Plus, Square } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { ChatFileCards } from '@/components/chat/chat-file-cards'
import { useChatComposer } from '@/hooks/use-chat-composer'
import type { ChatComposerProps } from '@/components/slots/chat-composer-contract'
import { cn } from '@/lib/utils'

/**
 * A card, not a form field (R-31 keeps fields fill-only): a 1px `--rule` line
 * that stays dark grey in dark mode, a soft shadow, and a darker line on focus,
 * as Codex and Linear draw their composers. The text sits above a button row.
 */
// Empty, focused and typing look the same: the 1px rule and a soft shadow. Focus only deepens the
// shadow (Codex); it never draws a dark outline (Alex 2026-10-31).
// InputGroup dims itself whenever anything inside is disabled; here that is the send button whenever the draft is
// empty, which left the whole composer at half opacity (border, surface and placeholder). A disabled textarea and
// disabled buttons still dim themselves.
const COMPOSER = 'rounded-2xl border border-rule bg-card shadow-sm has-disabled:opacity-100 transition-shadow has-[[data-slot=input-group-control]:focus-visible]:shadow-md has-[[data-slot=input-group-control]:focus-visible]:ring-0'

/** A send arrow with nothing to send is a solid grey control, not a faded black one. */
const SEND_DISABLED = 'disabled:bg-control disabled:text-muted-foreground disabled:opacity-100'

/**
 * The Grok-style composer every chat uses (Coordinator and bots): one rounded
 * bar, attach and the bot's model chip on the left, send on the right.
 */
export function ChatComposer(props: ChatComposerProps) {
  const { label, placeholder, sending = false, disabled = false, quote, model, thread = false } = props
  const t = useTranslations('Coordinator')
  const tShell = useTranslations('Shell')
  const composer = useChatComposer(props)
  const { fileInput } = composer

  return <form onSubmit={composer.onSubmit}>
    <FieldGroup className="sr-only w-px"><Field><FieldLabel htmlFor={fileInput.id}>{tShell('attach')}</FieldLabel><Input ref={fileInput.ref} id={fileInput.id} type="file" accept={fileInput.accept} multiple disabled={composer.attachDisabled} className="sr-only" tabIndex={-1} onChange={event => { fileInput.onFiles(event.target.files); event.target.value = '' }} /></Field></FieldGroup>
    <InputGroup className={COMPOSER} onDragOver={composer.onDragOver} onDrop={composer.onDrop} onPaste={composer.onPaste}>
      {quote && <InputGroupAddon align="block-start" className="px-2 pt-2 pb-0">{quote}</InputGroupAddon>}
      {(composer.files.length > 0 || composer.pending.length > 0) && <InputGroupAddon align="block-start" className="px-2 pt-2 pb-0"><ChatFileCards files={composer.files} pending={composer.pending} onRemove={composer.removeFile} onRetry={composer.retryFile} /></InputGroupAddon>}
      {/* readOnly, not disabled: a disabled field drops focus, so the next key went to page shortcuts. */}
      <InputGroupTextarea ref={composer.inputRef} aria-label={label} placeholder={placeholder ?? label} className={cn('max-h-48 min-w-0 overflow-x-hidden px-3.5 pt-3 pb-1 wrap-break-word', quote ? 'min-h-10' : 'min-h-14')} value={composer.text} maxLength={composer.maxLength} rows={2} disabled={disabled || undefined} readOnly={composer.readOnly} aria-busy={sending || undefined} onChange={event => composer.edit(event.target.value)} onKeyDown={composer.onKeyDown} data-chat-composer={thread ? undefined : ''} />
      <InputGroupAddon align="block-end" className="justify-between px-2 pt-0 pb-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <InputGroupButton type="button" variant="secondary" size="icon-sm" className="rounded-full pointer-coarse:size-11" aria-label={tShell('attach')} disabled={composer.attachDisabled} onClick={composer.openFilePicker}><Plus /></InputGroupButton>
          {model}
        </span>
        {composer.stoppable
          ? <InputGroupButton type="button" variant="default" size="icon-sm" className="rounded-full pointer-coarse:size-11" aria-label={t('stop')} onClick={composer.stop}><Square className="fill-current" /></InputGroupButton>
          : <InputGroupButton type="submit" variant="default" size="icon-sm" className={cn('rounded-full pointer-coarse:size-11', SEND_DISABLED)} aria-label={t('send')} disabled={!composer.canSend}>{sending ? <Spinner /> : <ArrowUp />}</InputGroupButton>}
      </InputGroupAddon>
    </InputGroup>
    {/* The limit is shown only when it is close enough to matter. */}
    {composer.length && <p role="status" aria-live="polite" className="px-3 pb-1 text-right text-xs text-muted-foreground">{t('lengthCount', composer.length)}</p>}
  </form>
}
