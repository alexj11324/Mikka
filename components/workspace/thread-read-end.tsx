'use client'
import { useCallback, useRef } from 'react'
import { setThreadRead } from '@/lib/thread-read-client'
import { VisibleReadEnd } from './visible-read-end'

export function ThreadReadEnd({ receipts }: { receipts: { id: string; through: string | null; revision: number; unread: boolean }[] }) {
  const sent = useRef(new Set<string>())
  const acknowledge = useCallback(() => {
    for (const { id, through, revision, unread } of receipts) {
      const key = JSON.stringify([id, through, revision])
      if (!unread || sent.current.has(key)) continue
      sent.current.add(key)
      void setThreadRead({ action: 'read', runId: id, through, revision }).catch(() => sent.current.delete(key))
    }
  }, [receipts])
  return <VisibleReadEnd onSeen={acknowledge} />
}
