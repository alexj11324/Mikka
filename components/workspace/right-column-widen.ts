'use client'

import { createContext, useContext } from 'react'

export type RightColumnWiden = { wide: boolean; onToggle: () => void }

/** The right column's ⤢ (RightColumn in thread-column.tsx), for the header of what it holds: a thread or a task. */
export const RightColumnWidenContext = createContext<RightColumnWiden | null>(null)

/** ⤢ of the right column this sits in; null elsewhere (task detail's thread pane, the Artifact window). */
export function useRightColumnWiden() {
  return useContext(RightColumnWidenContext)
}
