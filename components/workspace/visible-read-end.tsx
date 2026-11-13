'use client'
import { useEffect, useRef } from 'react'

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
    document.addEventListener('visibilitychange', acknowledge)
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', acknowledge) }
  }, [onSeen])
  return <span ref={ref} aria-hidden="true" className="block h-px" />
}
