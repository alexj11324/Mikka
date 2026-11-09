'use client'

/**
 * The 记忆 page (`?section=memory`). The open-source UI shows the settings 记忆
 * body there; a UI layer may draw its own from the same reads (docs/ui-overlay.md).
 */
import { MemorySettings } from './settings-memory'
import type { MemoryPageProps } from './memory-contract'

export function MemoryPage(_props: MemoryPageProps) {
  return <div className="mx-auto w-full max-w-3xl overflow-y-auto px-6 py-6"><MemorySettings /></div>
}
