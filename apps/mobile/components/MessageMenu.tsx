import type { ReactElement } from 'react'
import type { HeldMessage } from '@/lib/message-actions'

/** Elsewhere (the web build) a long press opens the actions sheet (app/message.tsx) instead. */
export const NATIVE_MESSAGE_MENU = false

export function MessageMenu({ children }: { message?: HeldMessage; children: ReactElement }) {
  return children
}
