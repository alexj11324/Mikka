'use client'

import { useEffect, useState } from 'react'

/** Repaint an age-filtered list once at its next local display boundary. This
 * does not fetch data, and hidden pages have no active display timer. */
export function useListExpiry(deadlines: readonly number[]) {
  const [, repaint] = useState(0)
  const serialized = JSON.stringify(deadlines.filter(Number.isFinite).toSorted((a, b) => a - b))
  useEffect(() => {
    const values = JSON.parse(serialized) as number[]
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(timer); timer = undefined
      if (document.visibilityState !== 'visible') return
      const now = Date.now(), next = values.find(at => at >= now)
      if (next !== undefined) timer = setTimeout(() => {
        repaint(value => value + 1)
        schedule()
      }, Math.min(2_147_483_647, Math.max(1, next - now + 1)))
    }
    const visible = () => {
      if (document.visibilityState === 'visible') repaint(value => value + 1)
      schedule()
    }
    schedule()
    document.addEventListener('visibilitychange', visible)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [serialized])
}
