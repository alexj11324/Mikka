'use client'

import { useCallback, useEffect, useState } from 'react'

// Seconds left before the person may send another request. It only counts
// down; nothing is sent again automatically.
export function useCooldown() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (seconds <= 0) return
    const timer = window.setTimeout(() => setSeconds(value => Math.max(0, value - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [seconds])
  const start = useCallback((value: number) => setSeconds(Math.max(0, Math.ceil(value))), [])
  return [seconds, start] as const
}
