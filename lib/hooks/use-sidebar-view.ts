'use client'

import { useCallback } from 'react'
import { useViewState } from './view-state'
import { type SidebarDensity, type SidebarFilter, type SidebarGroupBy, type SidebarRowKind, type SidebarSort } from '@/components/nav/sidebar-view'

/** What a frame reads to draw the sidebar's lists: Capy's view options, kept for this window's session. */
export type SidebarView = {
  /** 详细 (the default) or 紧凑. */
  density: SidebarDensity
  /** 置顶优先 (the list's own order), 最近活动 or 名称. */
  sort: SidebarSort
  /** 无, 未读, 有线程在等你 or 正在工作. */
  group: SidebarGroupBy
  /** Only the rows that match every filter that is on. */
  filters: SidebarFilter[]
  /** The search box's text; it narrows the section that opened the box, and only while the box is open. */
  search: string
  /** 「搜索线程」 was picked from a section's menu. */
  searchOpen: boolean
  /** Which section's menu opened it: its box sits under that section's heading, and only its rows are narrowed. */
  searchIn: SidebarRowKind
}

export type SidebarViewControls = {
  setDensity: (density: SidebarDensity) => void
  setSort: (sort: SidebarSort) => void
  setGroup: (group: SidebarGroupBy) => void
  /** 筛选: one dimension on or off; the menu shows which are on. */
  toggleFilter: (filter: SidebarFilter) => void
  clearFilters: () => void
  /** 搜索线程 from a section's menu. */
  openSearch: (section: SidebarRowKind) => void
  /** Closing the box drops its text too: a query nobody can see must not keep rows out of the list. */
  closeSearch: () => void
  setSearch: (text: string) => void
}

/** The view options as the section menus change them (components/nav/sidebar-view.ts holds the rules). */
export function useSidebarView(): SidebarView & SidebarViewControls {
  // Keys keep the names the frame already stored 密度 under, so nobody's saved choice resets.
  const [density, setDensity] = useViewState<SidebarDensity>('sidebar-density', 'detailed')
  const [sort, setSort] = useViewState<SidebarSort>('sidebar-sort', 'pinned')
  const [group, setGroup] = useViewState<SidebarGroupBy>('sidebar-group', 'none')
  const [filters, setFilters] = useViewState<SidebarFilter[]>('sidebar-filters', [])
  const [search, setSearch] = useViewState('sidebar-search', '')
  const [searchOpen, setSearchOpen] = useViewState('sidebar-search-open', false)
  const [searchIn, setSearchIn] = useViewState<SidebarRowKind>('sidebar-search-in', 'bot')
  // The choice is stored as picked; each section reads only the filters its own rows can answer (sidebarFilters).
  const toggleFilter = useCallback((filter: SidebarFilter) => {
    setFilters(previous => previous.includes(filter) ? previous.filter(value => value !== filter) : [...previous, filter])
  }, [setFilters])
  const clearFilters = useCallback(() => setFilters([]), [setFilters])
  const openSearch = useCallback((section: SidebarRowKind) => { setSearchIn(section); setSearchOpen(true) }, [setSearchIn, setSearchOpen])
  const closeSearch = useCallback(() => { setSearchOpen(false); setSearch('') }, [setSearch, setSearchOpen])
  return { density, sort, group, filters, search: searchOpen ? search : '', searchOpen, searchIn, setDensity, setSort, setGroup, toggleFilter, clearFilters, openSearch, closeSearch, setSearch }
}
