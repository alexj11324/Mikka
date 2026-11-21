'use client'

import { useEffect, useState } from 'react'

/** Scope copy feedback to the value on screen and wait for the browser write. */
export function useClipboardCopy(value: string) {
  const [result, setResult] = useState<{ value: string; state: 'pending' | 'copied' | 'failed' } | null>(null)
  const state = result?.value === value ? result.state : null

  useEffect(() => {
    if (result?.state !== 'copied') return
    const timer = setTimeout(() => setResult(null), 1500)
    return () => clearTimeout(timer)
  }, [result])

  async function copy() {
    setResult({ value, state: 'pending' })
    try {
      await navigator.clipboard.writeText(value)
      setResult({ value, state: 'copied' })
    } catch {
      setResult({ value, state: 'failed' })
    }
  }

  return { state, copy }
}
