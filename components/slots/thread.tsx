// The default thread slot (docs/ui-overlay.md): none. A Bot's chat draws its own rows (CoordinatorChat); a layer that
// draws a conversation as one screen exports `ThreadScreen` here.
import type { ComponentType } from 'react'
import type { ThreadScreenProps } from './thread-contract'

export const ThreadScreen: ComponentType<ThreadScreenProps> | null = null
