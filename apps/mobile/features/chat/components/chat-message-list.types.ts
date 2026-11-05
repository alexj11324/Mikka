import type { ReactElement, ReactNode } from 'react'

/**
 * Kill switch: false draws the chat with the earlier ScrollView, every message mounted, if the virtualized list
 * misbehaves on a device. Its paging and reads stay the same.
 */
export const VIRTUALIZED_CHAT_LIST = true

export type ChatListHandle = { toLatest: (animated?: boolean) => void }

export type ChatListProps<T> = {
  data: T[]
  keyOf: (item: T) => string
  renderItem: (item: T, index: number) => ReactElement | null
  /** Above the first message: the spinner or button for older messages. */
  header?: ReactNode
  /** After the last message: the outgoing messages, the waiting line, notices and proposals. */
  footer?: ReactNode
  /** Room left under the last row for the floating composer. */
  bottomInset: number
  /** The reader reached the top: load the page before. */
  onStartReached?: () => void
  /** Whether the latest message is in view, for the jump-to-latest button. */
  onAtLatestChange: (atLatest: boolean) => void
  scrollEnabled: boolean
  testID: string
}

