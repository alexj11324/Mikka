'use client'

import { useEffect, useRef, useState } from 'react'
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
) {
  const parsed = splitChatFiles(value)
  const [pending, setPending] = useState<PendingChatFile[]>([])
  const current = useRef({ value, onChange, scope, blocked })
  current.current = { value, onChange, scope, blocked }
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
    const running = uploads.current
    return () => {
      for (const controller of running.values()) controller.abort()
      running.clear()
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
  function remove(id: string) {
    if (current.current.blocked) return
    uploads.current.get(id)?.abort()
    uploads.current.delete(id)
    setPending((items) => items.filter((item) => item.key !== id))
    const draft = splitChatFiles(current.current.value)
    if (draft.files.some((file) => file.id === id)) {
      change(
        withChatFiles(
          draft.text,
          draft.files.filter((file) => file.id !== id),
        ),
      )
      void fetch(withBasePath(`/api/chat/attachments/${id}`), {
        method: 'DELETE',
        credentials: 'same-origin',
      }).catch(() => {})
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
    locked: pending.length > 0,
  }
}
