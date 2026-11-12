import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import type { ReactElement, ReactNode } from 'react'

/**
 * Kill switch: false draws the chat with the earlier ScrollView, every message mounted, if the virtualized list
 * misbehaves on a device. Its paging and reads stay the same.
 */
export const VIRTUALIZED_CHAT_LIST = true

export type ChatListHandle = { toLatest: (animated?: boolean) => void }

export type ChatListProps<T> = {
  data: T[]
  /** State outside the transcript that changes a visible row without changing its identity. */
  extraData?: unknown
  keyOf: (item: T) => string
  renderItem: (item: T, index: number) => ReactElement | null
  /** Above the first message: the spinner or button for older messages. */
  header?: ReactNode
  /** After the last message: the outgoing messages, the waiting line, notices and proposals. */
  footer?: ReactNode
  /** Room left under the last row for the floating composer. */
  bottomInset: number
  /**
   * The person's latest message (v0's send motion, #1408): the list leaves blank space under it so it can sit just
   * under the bar, and the reply fills that space without the list scrolling. Unset: no space is added.
   */
  anchorIndex?: number
  /** The reader reached the top: load the page before. */
  onStartReached?: () => void
  /** Whether the latest message is in view, for the jump-to-latest button. */
  onAtLatestChange: (atLatest: boolean) => void
  /** Each scroll, for the bar's backdrop (useScrolledUnderBar). */
  onScrollUnderBar?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  scrollEnabled: boolean
  testID: string
}

