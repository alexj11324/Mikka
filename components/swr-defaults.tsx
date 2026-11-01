'use client'

import type { ReactNode } from 'react'
import { SWRConfig } from 'swr'

/**
 * Site-wide SWR defaults. Focusing or showing the window again never re-reads
 * data (docs/design/decisions/2026-11-01-0400-no-refetch-on-focus.md): data
 * loads on mount, after the person's own changes, and on explicit polling.
 */
export const swrDefaults = { revalidateOnFocus: false } as const

export function SWRDefaults({ children }: { children: ReactNode }) {
  return <SWRConfig value={swrDefaults}>{children}</SWRConfig>
}
