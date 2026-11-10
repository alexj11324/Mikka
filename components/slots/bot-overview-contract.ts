// What the bot-overview slot receives (docs/ui-overlay.md): the body of a chat's 概览 when it is a tab of the
// conversation's work area (FRAME_OWNS_PANEL), the bot and then 详情 / 任务 / PR / 电脑 (R-02). Everything it shows
// and does is Mikka's, from ContextPanel (components/nav/context-panel.tsx) and components/nav/bot-overview.tsx.
import type { ReactNode } from 'react'

export type BotOverviewTab = 'details' | 'threads' | 'prs' | 'computer'

/** A row of 详情's lists: a routine or a library file. */
export type BotOverviewItem = { id: string; label: string }

export type BotOverviewPullRequest = { url: string; title: string; number: number; identifier?: string; state: 'open' | 'draft' | 'merged' | 'closed' }

export type BotOverviewProps = {
  /** Who the chat is with; `kind` 'agent' is an older chat without a bot. */
  conversation: { id?: string | null; name: string; color?: string; shape?: string; kind: 'coordinator' | 'bot' | 'agent' }
  /** The tabs this chat has (电脑 only where a computer is offered), the one shown and its words. */
  tabs: { id: BotOverviewTab; label: string }[]
  tab: BotOverviewTab
  onTab: (tab: BotOverviewTab) => void
  /** The search over 任务 and PR; null while it is closed. */
  query: string | null
  onQuery: (query: string | null) => void
  /** An ordinary bot's name and look, edited in place; null for the Coordinator and an older chat. Each resolves to an error to show, or null once saved. */
  edit: null | {
    rename: (name: string) => Promise<string | null>
    look: (patch: { color?: string; shape?: string }) => Promise<string | null>
    /** The look picker (shapes and colours), as 新建 Bot draws it. */
    picker: (props: { onError: (error: string | null) => void }) => ReactNode
  }
  /** 详情: the bot's public role (an ordinary bot only), its routines and its library. */
  details: {
    role: null | {
      loaded: boolean
      loadError: boolean
      retry: () => void
      value: string
      max: number
      dirty: boolean
      saving: boolean
      saved: boolean
      error: string | null
      edit: (value: string) => void
      reset: () => void
      save: () => Promise<void>
    }
    routines: BotOverviewItem[]
    /** The library; `onDelete` is set where the files are the person's own (asks first in the layer). */
    library: { items: BotOverviewItem[]; loadError: boolean; onDelete?: (item: BotOverviewItem) => Promise<void> }
  }
  /** 任务: the bot-tasks slot's list, rendered. */
  tasks: ReactNode
  /** PR: by 等待审查 / 进行中 / 已合并; `total` counts them before the search. */
  pullRequests: { total: number; groups: { id: string; label: string; rows: BotOverviewPullRequest[] }[] }
  /** 电脑: null without one. `screen` draws the live screen with `overlay` on it once it runs. */
  computer: null | {
    name: string
    state: 'loading' | 'missing' | 'ready'
    screen: (overlay: ReactNode) => ReactNode
    onOpen: () => void
    onAddKey: () => void
  }
  /** Mikka's dialogs this body opens (the computer viewer, 添加 E2B API Key). */
  dialogs?: ReactNode
}
