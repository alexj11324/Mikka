import { matchesQuery } from '@/lib/site-search'

/**
 * The sidebar's view options, as Capy's two section menus offer them (Sort by,
 * Group by, Density, Filters, Search threads): the pure part. The choices live in
 * `lib/hooks/use-sidebar-view.ts`, which keeps them for this window's session
 * (lib/hooks/view-state.tsx) so a frame only reads the answers.
 *
 * Only the dimensions our rows actually carry are offered (see `sidebarOptions`):
 * a Bot row has 未读 / 有线程在等你 / 正在工作, a group chat has 未读 alone.
 */
export const SIDEBAR_DENSITIES = ['detailed', 'compact'] as const
/** Capy's two densities: 详细 is two lines and a 32px picture, 紧凑 one line and a 20px one. */
export type SidebarDensity = (typeof SIDEBAR_DENSITIES)[number]

/** The list's own order is pinned first, then newest activity (bot-list.tsx); the other two sort it. */
export const SIDEBAR_SORTS = ['pinned', 'recent', 'name'] as const
export type SidebarSort = (typeof SIDEBAR_SORTS)[number]

/** Split the list into the rows that have this and the rest, headed 「未读」 / 「其他」. */
export const SIDEBAR_GROUPS = ['none', 'unread', 'waiting', 'working'] as const
export type SidebarGroupBy = (typeof SIDEBAR_GROUPS)[number]

/** Keep only the rows that match; every filter that is on must match. */
export const SIDEBAR_FILTERS = ['unread', 'waiting', 'working'] as const
export type SidebarFilter = (typeof SIDEBAR_FILTERS)[number]

/** A Bot's section lists Bots (and the Coordinator); the other section lists group chats. */
export type SidebarRowKind = 'bot' | 'group'

/** What one kind of section can be grouped and filtered by. A group chat has no thread work under it. */
export function sidebarOptions(kind: SidebarRowKind): { groups: readonly SidebarGroupBy[]; filters: readonly SidebarFilter[] } {
  return kind === 'bot'
    ? { groups: SIDEBAR_GROUPS, filters: SIDEBAR_FILTERS }
    : { groups: ['none', 'unread'], filters: ['unread'] }
}

/** A saved choice the other section does not offer reads as 无 / nothing filtered, never as a list that cannot say why it is empty. */
export function sidebarGroupBy(kind: SidebarRowKind, group: SidebarGroupBy): SidebarGroupBy {
  return sidebarOptions(kind).groups.includes(group) ? group : 'none'
}

export function sidebarFilters(kind: SidebarRowKind, filters: readonly SidebarFilter[]): SidebarFilter[] {
  const offered = sidebarOptions(kind).filters
  return filters.filter((filter, index) => offered.includes(filter) && filters.indexOf(filter) === index)
}

/** A sidebar row as the view options read it: a Bot's row or a group chat's (ChatNavEntry). */
export type SidebarViewRow = {
  id: string
  name: string
  unread: boolean
  /** Its latest activity, which 最近活动 sorts by. */
  at?: string | null
  /** Its latest line, which the search box reads too. */
  preview?: string | null
  /** A live turn. */
  working?: boolean
  /** How many threads under it wait on the person. */
  waitingCount?: number
  /** The titles of the threads under it, so the search box finds a Bot by what it dispatched. */
  threads?: readonly string[]
}

/** 置顶优先 keeps the list's own order; 最近活动 and 名称 sort every row by that one thing. */
export function sortSidebarRows<T extends SidebarViewRow>(rows: readonly T[], sort: SidebarSort): T[] {
  if (sort === 'pinned') return [...rows]
  const byName = (a: T, b: T) => a.name.localeCompare(b.name)
  if (sort === 'name') return [...rows].sort(byName)
  return [...rows].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || byName(a, b))
}

/** Whether a row is what the group asks for: 未读, a thread waiting on the person, or a live turn. */
function inGroup(row: SidebarViewRow, group: Exclude<SidebarGroupBy, 'none'>) {
  if (group === 'unread') return row.unread
  if (group === 'waiting') return (row.waitingCount ?? 0) > 0
  return Boolean(row.working)
}

/** Every filter that is on must match: 未读, 有线程在等你, 正在工作. */
export function matchesSidebarFilters(row: SidebarViewRow, filters: readonly SidebarFilter[]) {
  return filters.every(filter => inGroup(row, filter))
}

/** The search box reads the row's name, its latest line and the threads under it. */
export function matchesSidebarQuery(row: SidebarViewRow, query: string) {
  const text = query.trim()
  if (!text) return true
  return matchesQuery([row.name, row.preview ?? '', ...(row.threads ?? [])].join(' '), text)
}

/** The rows the section keeps, in the order they arrived: what the filters and the search box leave. */
export function filterSidebarRows<T extends SidebarViewRow>(rows: readonly T[], filters: readonly SidebarFilter[], query: string): T[] {
  return rows.filter(row => matchesSidebarFilters(row, filters) && matchesSidebarQuery(row, query))
}

/** One headed run of rows: `all` while 分组 is 无, else the group asked for and then `other`. */
export type SidebarBucket<T> = { id: 'all' | Exclude<SidebarGroupBy, 'none'> | 'other'; rows: T[] }

/** Split the rows into at most two buckets; a bucket with nothing in it is left out. */
export function groupSidebarRows<T extends SidebarViewRow>(rows: readonly T[], group: SidebarGroupBy): SidebarBucket<T>[] {
  if (group === 'none') return rows.length ? [{ id: 'all', rows: [...rows] }] : []
  const inside = rows.filter(row => inGroup(row, group))
  const rest = rows.filter(row => !inGroup(row, group))
  return [...(inside.length ? [{ id: group, rows: inside } as const] : []), ...(rest.length ? [{ id: 'other' as const, rows: rest }] : [])]
}
