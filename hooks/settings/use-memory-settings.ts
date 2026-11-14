'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { getMemory, removeFact, setMemory, updateFact } from '@/app/actions/memory'

export type MemoryData = Awaited<ReturnType<typeof getMemory>>
export type MemoryFact = MemoryData['facts'][number]

type MemoryChange = {
  save: () => Promise<unknown>
  apply: (current: MemoryData) => MemoryData
}

/**
 * 记忆 (R-73): the person's facts, the switch, and correcting or deleting a
 * fact, each saved optimistically and rolled back when refused. Shared by the
 * open-source page and the hosted layer (docs/ui-overlay.md).
 */
export function useMemorySettings() {
  const { data, error, mutate } = useSWR('memory', getMemory)
  const [failedChange, setFailedChange] = useState<MemoryChange | null>(null)

  async function run(change: MemoryChange) {
    const shown = data
    if (!shown) return
    setFailedChange(null)
    try {
      await mutate(async current => {
        // Fact writes return false when the saved fact can no longer be changed.
        if (await change.save() === false) throw new Error('Memory change refused')
        return change.apply(current ?? shown)
      }, { optimisticData: current => change.apply(current ?? shown), rollbackOnError: true, revalidate: false })
    } catch {
      setFailedChange(change)
      return
    }
    // A correction may merge facts and remove the edited id. Keep the server's
    // surviving rows; a failed confirmation remains a read error, not a refused write.
    await mutate().catch(() => undefined)
  }

  return {
    data, error, failed: failedChange !== null,
    // Both memory surfaces call reload from their Retry button. Re-read after a
    // read failure; after a refused save, retry the person's original edit.
    reload: () => failedChange ? run(failedChange) : mutate(),
    setEnabled: (enabled: boolean) => run({
      save: () => setMemory(enabled),
      apply: current => ({ ...current, enabled }),
    }),
    /** Corrects a fact; an empty text changes nothing. */
    correct: async (id: string, subject: string) => {
      if (!subject.trim()) return
      await run({
        save: () => updateFact(id, subject),
        apply: current => ({ ...current, facts: current.facts.map(fact => fact.id === id ? { ...fact, subject: subject.trim(), userEdited: true } : fact) }),
      })
    },
    remove: (id: string) => run({
      save: () => removeFact(id),
      apply: current => ({ ...current, facts: current.facts.filter(item => item.id !== id) }),
    }),
  }
}
