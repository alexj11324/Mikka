'use client'

import { useEffect, useId, useRef, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { TEXT_ATTACHMENT_ACCEPT, textAttachment } from '@/lib/text-attachment'
import { MESSAGE_MAX } from '@/lib/message-limits'
import { sendsMessage } from '@/lib/send-key'
import { CHAT_FILE_ACCEPT } from '@mikka/protocol/chat-attachments'
import { useChatFiles } from '@/components/chat/use-chat-files'
import type { ChatComposerProps } from '@/components/slots/chat-composer-contract'

/**
 * Everything a chat composer does, for the chat-composer slot to draw
 * (docs/ui-overlay.md): the draft, its attachments, the send key, Esc to stop,
 * drop and paste, the length limit. The default slot and the hosted layer both
 * call it, so the two composers cannot behave differently.
 */
export function useChatComposer({ ref, value, onChange, onSubmit, sending = false, running = false, editableWhileSending = false, submitDisabled = false, disabled = false, onStop, sendKey = 'enter', thread = false, attachmentScope }: ChatComposerProps) {
  const tShell = useTranslations('Shell')
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const fileId = useId()
  const files = useChatFiles(value, onChange, attachmentScope, sending || disabled, tShell)
  const stoppable = !!onStop && (sending || (running && !value.trim()))
  const canSend = !sending && !submitDisabled && !disabled && !files.locked && !!value.trim()

  const setInput = (node: HTMLTextAreaElement | null) => {
    inputRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }

  // Browsers without `field-sizing: content` get the same one-line-to-max-height growth from scrollHeight,
  // so the draft never scrolls sideways.
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

  async function attachText(items: File[]) {
    if (sending || disabled || !items.length) return
    let next = value
    for (const file of items) {
      const block = await textAttachment(file, MESSAGE_MAX - next.length - 2)
      if (!block) { toast.error(tShell('attachUnsupported', { max: MESSAGE_MAX })); continue }
      next = next.trim() ? `${next.trimEnd()}\n\n${block}` : block
    }
    onChange(next)
    inputRef.current?.focus()
  }

  /** Files from the picker, a drop or a paste: uploaded as chat files where the chat takes them, otherwise read in as text. */
  function addFiles(items: File[]) {
    if (attachmentScope) files.add(items)
    else void attachText(items)
  }

  function submit() { if (canSend) onSubmit() }

  return {
    /** The draft as the textarea shows it: attached files' markers are kept out of it. */
    text: files.text,
    edit: files.edit,
    /** The textarea's maxLength, so the whole message, file markers included, stays within the limit. */
    maxLength: MESSAGE_MAX - (value.length - files.text.length),
    /** Show `count / max` only when it is close enough to matter. */
    length: value.length > MESSAGE_MAX - 500 ? { count: value.length, max: MESSAGE_MAX } : null,
    files: files.files,
    pending: files.pending,
    removeFile: files.remove,
    retryFile: files.retry,
    /** The button shows stop instead of send. */
    stoppable,
    stop: onStop,
    canSend,
    submit,
    /** The textarea cannot be edited (a reply is on its way and cannot be stopped). Not disabled, so focus stays. */
    readOnly: sending && !onStop && !editableWhileSending,
    attachDisabled: sending || disabled,
    /** The hidden file input the attach button opens. */
    fileInput: { ref: fileRef, id: fileId, accept: attachmentScope ? CHAT_FILE_ACCEPT : TEXT_ATTACHMENT_ACCEPT, onFiles: (list: FileList | null) => addFiles(Array.from(list ?? [])) },
    openFilePicker: () => fileRef.current?.click(),
    inputRef: setInput,
    onSubmit: (event: FormEvent) => { event.preventDefault(); submit() },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      const { key, shiftKey, metaKey, ctrlKey } = event
      // In a bot chat Esc stops the reply, as the stop button does.
      if (key === 'Escape' && stoppable && !thread && !event.nativeEvent.isComposing) { event.preventDefault(); onStop?.(); return }
      if (!sendsMessage({ key, shiftKey, metaKey, ctrlKey, isComposing: event.nativeEvent.isComposing }, sendKey)) return
      event.preventDefault()
      submit()
    },
    onDragOver(event: DragEvent) {
      if (!Array.from(event.dataTransfer.types).includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = sending || disabled ? 'none' : 'copy'
    },
    onDrop(event: DragEvent) {
      const dropped = Array.from(event.dataTransfer.files)
      if (!dropped.length) return
      event.preventDefault()
      event.stopPropagation()
      addFiles(dropped)
    },
    onPaste(event: ClipboardEvent) {
      const pasted = Array.from(event.clipboardData.files)
      if (!pasted.length) return
      event.preventDefault()
      event.stopPropagation()
      addFiles(pasted)
    },
  }
}

export type ChatComposerState = ReturnType<typeof useChatComposer>
