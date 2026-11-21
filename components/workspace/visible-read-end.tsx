'use client'
import { useEffect, useRef } from 'react'
import { watchPageVisibility } from '@/lib/live/browser-runtime'

/** Put this inside the last row that actually rendered. IntersectionObserver
 * handles every clipping ancestor, including the hosted scroll container. */
export function VisibleReadEnd({ onSeen }: { onSeen: () => void }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const end = ref.current
    if (!end) return
    let visible = false
    const acknowledge = () => { if (visible && document.visibilityState === 'visible') onSeen() }
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 1)
      acknowledge()
    }, { threshold: 1 })
    observer.observe(end)
    const unwatch = watchPageVisibility(acknowledge)
    return () => { observer.disconnect(); unwatch() }
  }, [onSeen])
  return <span ref={ref} aria-hidden="true" className="block h-px" />
}
