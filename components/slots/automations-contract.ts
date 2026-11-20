// What the automations slot receives (docs/ui-overlay.md). 自动化's list page (AutomationsPage,
// components/automations/automations-page.tsx) keeps its data, filters, saves and navigation; a layer draws the page
// from these props: the 我的 / 全部 / 定时 tabs, the filter chips and menus, the groups of rows, the templates and the
// 新建自动化 window with its three ways to start.
import type { MouseEvent, ReactNode } from 'react'

/** 我的自动化 · 全部自动化 · 定时. A tab is a preset of the filters below; changing a filter can leave no tab selected. */
export type AutomationsTab = 'mine' | 'all' | 'scheduled'
/** What starts an automation, for the row's and the template card's icon: the first event trigger, else its timing. */
export type AutomationTriggerKind = 'schedule' | 'manual' | 'github' | 'linear' | 'slack' | 'webhook'
/** 状态 in the filter menu (the old 全部 / 运行中 / 已暂停 / 已删除 toggles). */
export type AutomationStatusFilter = 'all' | 'active' | 'paused' | 'deleted'
/** 分组: by state (运行中 N, 已暂停 N, 已结束) or by 文件夹 (置顶, then each folder). */
export type AutomationGrouping = 'status' | 'folder'

export type AutomationRow = {
  id: string
  title: string
  /** The automation's own address, for a modified click or a new tab. */
  href: string
  trigger: AutomationTriggerKind
  /** 「工作日 9:00 (America/New_York) · GitHub: PR 打开」: its timing in its own zone, then its event triggers. */
  schedule: string
  /** The next run as its own clock reads it; null when none is due. */
  nextRun: { at: string; label: string } | null
  status: 'active' | 'paused' | 'completed' | 'cancelled'
  /** The state's word (已暂停 reads 自动暂停 when the host paused it). */
  statusLabel: string
  /** Who created it; null when they left the workspace. */
  creator: { name: string; image: string | null } | null
  /** 交给: the Bot it hands work to, as Mikka draws it (avatar and name). */
  handler: ReactNode
  /** Last change, for the relative time at the row's end. */
  updatedAt: string | null
  pinned: boolean
  tags: string[]
  deleted: boolean
  /** 恢复 is offered (a deleted automation its reader created or may take over). */
  canRestore: boolean
  /** 文件夹和标签 is offered. */
  canOrganize: boolean
}

export type AutomationGroup = {
  key: string
  label: string
  /** The group's size; for 运行中 and 已暂停 the server's count over the whole filtered list, not just the rows read. */
  count: number
  rows: AutomationRow[]
}

/** 模板: one of Mikka's ready automations. Picking it opens the editor filled in; nothing runs until it is saved. */
export type AutomationTemplateCard = { id: string; title: string; description: string; trigger: AutomationTriggerKind; triggerLabel: string }

export type AutomationsPageProps = {
  tab: AutomationsTab | null
  onTab: (tab: AutomationsTab) => void
  /** The filter chips: 创建者是我, 触发方式是定时, and 状态 when it is not 全部. ✕ drops one. */
  filters: { creatorIsMe: boolean; scheduledOnly: boolean; status: AutomationStatusFilter }
  onFilters: (change: Partial<AutomationsPageProps['filters']>) => void
  /** 显示: grouping and whether the templates show under the list. */
  display: { grouping: AutomationGrouping; showTemplates: boolean }
  onDisplay: (change: Partial<AutomationsPageProps['display']>) => void
  query: string
  onQuery: (query: string) => void
  /** A tag picked from a row narrows the list to it; null when none. */
  tag: string | null
  onTag: (tag: string | null) => void
  /** First page still loading (no rows yet). */
  loading: boolean
  /** The first page failed; `onRetry` reads it again. */
  error: boolean
  onRetry: () => void
  groups: AutomationGroup[]
  /** Why the list is empty: nothing at all, nothing matching the filters, or nothing deleted. Null while rows show. */
  empty: 'none' | 'filtered' | 'deleted' | null
  /** Clears every filter, the search and the tag (the filtered empty state's action). */
  onClearFilters: () => void
  more: boolean
  loadingMore: boolean
  onMore: () => void
  /** Opens a row in place; the row is also a link (`href`), and a modified click keeps the browser's own behaviour. */
  onOpen: (id: string, event: MouseEvent) => void
  onPin: (row: AutomationRow) => void
  onOrganize: (row: AutomationRow) => void
  onRestore: (row: AutomationRow) => void
  /** 查看运行: the thread directory filtered to this automation's runs. */
  onViewRuns: (row: AutomationRow) => void
  /** The row being restored; others wait. */
  restoring: string | null
  templates: AutomationTemplateCard[]
  onTemplate: (id: string) => void
  /** 新建自动化: the window with 从零开始, 从模板开始 (its own list of the templates) and 让 Mikka 帮你建 (a Bot builds it in a thread). */
  create: { open: boolean; onOpenChange: (open: boolean) => void; onScratch: () => void; onAskBot: () => void }
  /** 文件夹和标签's dialog, as Mikka draws it; null when closed. */
  dialogs: ReactNode
}
