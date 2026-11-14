'use client'

import { useEffect, useReducer, useRef, useState } from 'react'
import type { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  CHAT_FILE_MAX_BYTES,
  CHAT_FILE_MAX_COUNT,
  splitChatFiles,
  supportedChatFile,
  withChatFiles,
  type ChatFileScope,
} from '@mikka/protocol/chat-attachments'
import { MESSAGE_MAX } from '@/lib/message-limits'
import { ChatUploadError, uploadChatFile } from '@/lib/chat-attachments/client'
import { withBasePath } from '@/lib/base-path'

export interface PendingChatFile {
  key: string
  file: File
  state: 'uploading' | 'processing' | 'error'
  percent: number
  error?: string
}
export function useChatFiles(
  value: string,
  onChange: (value: string) => void,
  scope: ChatFileScope | undefined,
  blocked: boolean,
  translate: ReturnType<typeof useTranslations<'Shell'>>,
) {
  const parsed = splitChatFiles(value)
  const [pending, setPending] = useState<PendingChatFile[]>([])
  const current = useRef({ value, onChange, scope, blocked })
  current.current = { value, onChange, scope, blocked }
  // Keep each removal pending, including a failed attempt, until it is confirmed or explicitly canceled.
  const removals = useRef(new Map<string, AbortController | null>())
  const [, renderRemovals] = useReducer((revision: number) => revision + 1, 0)
  const uploads = useRef(new Map<string, AbortController>())
  const scopeKey = scope ? `${scope.kind}:${scope.id}` : ''
  const previousScope = useRef(scopeKey)
  useEffect(() => {
    if (previousScope.current && previousScope.current !== scopeKey) {
      const draft = splitChatFiles(current.current.value)
      if (draft.files.length) {
        current.current.value = draft.text
        current.current.onChange(draft.text)
      }
    }
    previousScope.current = scopeKey
    setPending([])
    const removing = removals.current
    const running = uploads.current
    return () => {
      for (const controller of running.values()) controller.abort()
      running.clear()
      for (const [id, controller] of removing) {
        controller?.abort()
        toast.dismiss(id)
      }
      removing.clear()
    }
  }, [scopeKey])
  const change = (next: string) => {
    current.current.value = next
    current.current.onChange(next)
  }
  const edit = (text: string) => change(withChatFiles(text, splitChatFiles(current.current.value).files))
  async function start(item: PendingChatFile) {
    const original = current.current.scope
    if (!original || current.current.blocked) return
    const controller = new AbortController()
    uploads.current.set(item.key, controller)
    setPending((items) => [
      ...items.filter((entry) => entry.key !== item.key),
      { ...item, state: 'uploading', error: undefined },
    ])
    try {
      const file = await uploadChatFile(item.file, original, controller.signal, (state, percent) =>
        setPending((items) =>
          items.map((entry) => (entry.key === item.key ? { ...entry, state, percent } : entry)),
        ),
      )
      if (
        controller.signal.aborted ||
        current.current.scope?.kind !== original.kind ||
        current.current.scope?.id !== original.id
      )
        return
      const draft = splitChatFiles(current.current.value)
      const next = withChatFiles(draft.text, [...draft.files, file])
      if (next.length > MESSAGE_MAX) throw new ChatUploadError('tooLong')
      change(next)
      setPending((items) => items.filter((entry) => entry.key !== item.key))
    } catch (error) {
      if (!controller.signal.aborted)
        setPending((items) =>
          items.map((entry) =>
            entry.key === item.key
              ? {
                  ...entry,
                  state: 'error',
                  error: error instanceof ChatUploadError ? error.code : 'unavailable',
                }
              : entry,
          ),
        )
    } finally {
      uploads.current.delete(item.key)
    }
  }
  function add(files: File[]) {
    if (!current.current.scope || current.current.blocked) return
    const occupied = splitChatFiles(current.current.value).files.length + uploads.current.size
    for (const [index, file] of files.entries()) {
      const error =
        occupied + index >= CHAT_FILE_MAX_COUNT
          ? 'tooMany'
          : file.size > CHAT_FILE_MAX_BYTES
            ? 'tooLarge'
            : !supportedChatFile(file.name, file.type)
              ? 'unsupported'
              : undefined
      const item: PendingChatFile = {
        key: crypto.randomUUID(),
        file,
        state: error ? 'error' : 'uploading',
        percent: 0,
        error,
      }
      if (error) setPending((items) => [...items, item])
      else void start(item)
    }
  }
  function finishRemoval(id: string) {
    removals.current.delete(id)
    toast.dismiss(id)
    renderRemovals()
  }
  async function remove(id: string) {
    if (current.current.blocked || removals.current.get(id)) return
    const file = splitChatFiles(current.current.value).files.find(entry => entry.id === id)
    if (!file) {
      uploads.current.get(id)?.abort()
      uploads.current.delete(id)
      setPending(items => items.filter(item => item.key !== id))
      return
    }

    const controller = new AbortController()
    removals.current.set(id, controller)
    toast.dismiss(id)
    renderRemovals()
    try {
      const response = await fetch(withBasePath(`/api/chat/attachments/${id}`), {
        method: 'DELETE',
        credentials: 'same-origin',
        signal: controller.signal,
      })
      if (!response.ok) throw new ChatUploadError('unavailable')
      if (controller.signal.aborted) return
      const draft = splitChatFiles(current.current.value)
      change(withChatFiles(draft.text, draft.files.filter(entry => entry.id !== id)))
      finishRemoval(id)
    } catch {
      if (controller.signal.aborted) return
      removals.current.set(id, null)
      const keep = () => {
        if (removals.current.get(id) === null) finishRemoval(id)
      }
      toast.error(translate('attachments.removeFailed', { name: file.name }), {
        id,
        duration: Infinity,
        onDismiss: keep,
        action: {
          label: translate('attachments.retryRemoval'),
          onClick: event => {
            event.preventDefault()
            void remove(id)
          },
        },
        cancel: { label: translate('attachments.keep'), onClick: keep },
      })
    }
  }
  return {
    text: parsed.text,
    files: parsed.files,
    pending,
    add,
    remove,
    retry: (item: PendingChatFile) => {
      void start(item)
    },
    edit,
    locked: pending.length > 0 || removals.current.size > 0,
  }
}
