'use client'
import { useEffect, useRef } from 'react'
import { setThreadRead } from '@/lib/thread-read-client'

/** This marker is inside the last transcript row, in both the hosted block
 * and the bare review panel. Background tabs and content above the fold cannot
 * advance the read position. The receipt includes the observed manual revision. */
export function ThreadReadEnd({ receipts }: { receipts: { id: string; through: string | null; revision: number; unread: boolean }[] }) {
  const ref = useRef<HTMLSpanElement>(null)
  const sent = useRef(new Set<string>())
  useEffect(() => {
    const end = ref.current
    if (!end) return
    let visible = false
    const acknowledge = () => {
      if (!visible || document.visibilityState !== 'visible') return
      for (const { id, through, revision, unread } of receipts) {
        const key = JSON.stringify([id, through, revision])
        if (!unread || sent.current.has(key)) continue
        sent.current.add(key)
        void setThreadRead({ action: 'read', runId: id, through, revision }).catch(() => sent.current.delete(key))
      }
    }
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 1)
      acknowledge()
    }, { threshold: 1 })
    observer.observe(end)
    document.addEventListener('visibilitychange', acknowledge)
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', acknowledge) }
  }, [receipts])
  return <span ref={ref} aria-hidden="true" className="block h-px" />
}
