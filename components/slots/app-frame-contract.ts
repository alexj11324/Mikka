// What 外框 receives (docs/ui-overlay.md): the app window around every page —
// the gray frame, the window bar across the top, the icon rail on the left and
// the rounded card that holds the page. The window bar's content (search, the
// panel and 全部任务 buttons) arrives as `bar` and is drawn as given; the
// right-hand panel lives inside the page, not here.
import type { ReactNode } from 'react'
import type { RailProps } from '@/components/nav/rail-items'

export type AppFrameProps = {
  /** The window bar (WindowBar), drawn as given. */
  bar: ReactNode
  /** The icon rail (IconRail). */
  rail: ReactNode
  children: ReactNode
  /** Settings drawn inside this frame: its own palette applies (SETTINGS_COLORS in app-frame-view.tsx). */
  settings?: boolean
}

/** The icon rail: RAIL_ITEMS, the update button and the account menu (WorkspaceMenu, compact). */
export type IconRailProps = RailProps

/**
 * The frame owns chat navigation through RailProps.chats. FRAME_LISTS_CHATS controls
 * whether the shared mobile header supplies a list toggle.
 */
export type FrameListsChats = boolean

/**
 * `FRAME_OWNS_PANEL`: true when the conversation's own right-hand work area holds the chat's Overview and the
 * browser as tabs (ThreadScreenProps.panels), so the page draws no right column of its own beside a chat.
 * `FRAME_OWNS_HEADER`: true when the frame has its own search, Inbox count and work area, so the window bar
 * carries only ← → (in the desktop app) and the page header no search or 全部任务 buttons.
 */
export type FrameOwnsPanel = boolean
