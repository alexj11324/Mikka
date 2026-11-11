'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { getMemory, removeFact, setMemory, updateFact } from '@/app/actions/memory'

export type MemoryData = Awaited<ReturnType<typeof getMemory>>
export type MemoryFact = MemoryData['facts'][number]

/**
 * 记忆 (R-73): the person's facts, the switch, and correcting or deleting a
 * fact, each saved optimistically and rolled back when refused. Shared by the
 * open-source page and the hosted layer (docs/ui-overlay.md).
 */
export function useMemorySettings() {
  const { data, error, mutate } = useSWR('memory', getMemory)
  const [failed, setFailed] = useState(false)

  async function run(change: () => Promise<unknown>, next: (current: MemoryData) => MemoryData) {
    const shown = data
    if (!shown) return
    setFailed(false)
    try {
      await mutate(async current => {
        // Fact writes return false when the saved fact can no longer be changed.
        if (await change() === false) throw new Error('Memory change refused')
        return next(current ?? shown)
      }, { optimisticData: current => next(current ?? shown), rollbackOnError: true, revalidate: false })
    } catch {
      setFailed(true)
    }
  }

  return {
    data, error, failed,
    reload: () => { setFailed(false); return mutate() },
    setEnabled: (enabled: boolean) => run(() => setMemory(enabled), current => ({ ...current, enabled })),
    /** Corrects a fact; an empty text changes nothing. */
    correct: async (id: string, subject: string) => {
      if (!subject.trim()) return
      await run(() => updateFact(id, subject), current => ({ ...current, facts: current.facts.map(fact => fact.id === id ? { ...fact, subject: subject.trim(), userEdited: true } : fact) }))
    },
    remove: (id: string) => run(() => removeFact(id), current => ({ ...current, facts: current.facts.filter(item => item.id !== id) })),
  }
}
