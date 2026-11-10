'use client'

/**
 * 外框: the app window and its icon rail. The open-source UI draws the shared
 * ones; a UI layer may draw its own from the same props (docs/ui-overlay.md).
 * The pages, the window bar's content and the right-hand panel are not part of it.
 */
export { AppFrameView as AppFrame } from '@/components/app-frame-view'
export { IconRailView as IconRail } from '@/components/nav/icon-rail-view'
/** The open-source frame leaves the chats to the page's bot list. */
export const FRAME_LISTS_CHATS = false
/** The open-source page draws its own right-hand panel (Overview, the browser) beside the chat. */
export const FRAME_OWNS_PANEL = false
/** The open-source window bar keeps search, ✋ and 🌐. */
export const FRAME_OWNS_HEADER = false
