// What the search slot receives (docs/ui-overlay.md): ⌘K over everything (MIK-36), as data. GlobalSearch
// (components/nav/global-search.tsx) reads, filters and pages the results (useSiteSearch, GET /api/search) and hands a
// layer the open state, the query and the sections to draw; a row's `select` does what picking it does (open, close,
// load more, retry).
import type { LucideIcon } from 'lucide-react'
import type { StatusTone } from '@/lib/status-appearance'

/** What leads a row: the Coordinator's or a bot's avatar, a name's letter, the thread mark, or an icon. */
export type SearchLead =
  | { kind: 'coordinator' }
  | { kind: 'bot'; id: string; color?: string | null; shape?: string | null }
  | { kind: 'letter'; name: string }
  | { kind: 'thread' }
  /** A plain glyph: actions, 加载更多 and 重试. */
  | { kind: 'glyph'; icon: LucideIcon }
  /** An icon on a round tile: group chats, tasks and projects. */
  | { kind: 'icon'; icon: LucideIcon }

export type SearchRow = {
  /** Unique within the palette. */
  key: string
  label: string
  /** A task's identifier, drawn before the label. */
  identifier?: string
  /** The second line: the Coordinator's last line, a conversation's preview, a task's assignee, a thread's last reply, a project's summary. */
  detail?: string
  /** The authorized TaskPresentation for this hit, once available. */
  status?: { label: string; tone: StatusTone }
  /** Words on the row's end: 重试 on the retry row. */
  trailing?: string
  lead: SearchLead
  /** 加载更多 while that page loads. */
  busy?: boolean
  disabled?: boolean
  select: () => void
}

export type SearchSectionId = 'actions' | 'bots' | 'conversations' | 'groupChats' | 'tasks' | 'threads' | 'projects' | 'retry'

/** Sections in the order they show: 快捷操作 first while there is a query, last without one. */
export type SearchSection = { id: SearchSectionId; heading?: string; rows: SearchRow[] }

export type SearchPaletteProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** usePresence's end of the closing motion: the caller unmounts the palette then. */
  onOpenChangeComplete?: (open: boolean) => void
  query: string
  onQueryChange: (query: string) => void
  maxLength: number
  sections: SearchSection[]
  /** GET /api/search is reading. */
  searching: boolean
  /** The status line: searching, too long, nothing matches or the count; empty with no query. */
  announce: string
  /** The line in place of results (nothing matches, or the query is too long); null while there are results or a search runs. */
  empty: string | null
  /** The sign-in expired, so the server search stopped; shown in place of the retry row. */
  authError: string | null
}
