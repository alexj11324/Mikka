/**
 * Order, collapse and drop targets for the home list (#1408). Sections stay 正在工作 / Bot / 群聊:
 * a chat can be reordered inside its section, pinned, or unpinned back into that section.
 * It cannot change section, because working and 群聊 are not something the person assigns.
 */

export type SectionId = 'working' | 'bots' | 'groups'

export type ChatOrder = {
  pins: string[]
  sections: Record<SectionId, string[]>
}

export type OrderRow = { id: string; kind: 'bot' | 'group'; pinned: boolean; working: boolean; coordinator?: boolean }

export type DropTarget = { zone: 'pins'; index: number } | { zone: 'section'; id: SectionId; index: number }

const SECTIONS: SectionId[] = ['working', 'bots', 'groups']

export function emptyOrder(): ChatOrder {
  return { pins: [], sections: { working: [], bots: [], groups: [] } }
}

/** The list a chat belongs in once it is not pinned. */
export function naturalSection(row: OrderRow): SectionId {
  if (row.kind === 'group') return 'groups'
  return row.working ? 'working' : 'bots'
}

function bySaved<T extends { id: string }>(items: readonly T[], saved: readonly string[]): T[] {
  const map = new Map(items.map(item => [item.id, item]))
  const known = saved.flatMap(id => map.get(id) ?? [])
  const placed = new Set(known.map(item => item.id))
  return [...known, ...items.filter(item => !placed.has(item.id))]
}

/** The Coordinator is the first pin. Other pins keep `saved`, then the order they were given. */
function coordinatorFirst<R extends OrderRow>(pinned: readonly R[]): R[] {
  const first = pinned.filter(row => row.coordinator)
  return [...first, ...pinned.filter(row => !row.coordinator)]
}

function pinIdsWithCoordinatorFirst(ids: readonly string[], rows: readonly OrderRow[]): string[] {
  const coordinator = rows.find(row => row.coordinator && ids.includes(row.id))?.id
  if (!coordinator) return [...ids]
  return [coordinator, ...ids.filter(id => id !== coordinator)]
}

/** Rows in home order: the Coordinator first among pins, then each section. */
export function orderedRows<R extends OrderRow>(rows: readonly R[], saved: ChatOrder | null): R[] {
  const pinned = rows.filter(row => row.kind === 'bot' && row.pinned)
  const rest = rows.filter(row => !(row.kind === 'bot' && row.pinned))
  if (!saved) return [...coordinatorFirst(pinned), ...rest]
  const section = (id: SectionId) => rest.filter(row => naturalSection(row) === id)
  return [
    ...coordinatorFirst(bySaved(pinned, saved.pins)),
    ...bySaved(section('working'), saved.sections.working),
    ...bySaved(section('bots'), saved.sections.bots),
    ...bySaved(section('groups'), saved.sections.groups),
  ]
}

function visualOrder(rows: readonly OrderRow[]): ChatOrder {
  const order = emptyOrder()
  for (const row of rows) {
    if (row.kind === 'bot' && row.pinned) order.pins.push(row.id)
    else order.sections[naturalSection(row)].push(row.id)
  }
  return order
}

function moveId(ids: string[], id: string, index: number): string[] {
  const without = ids.filter(item => item !== id)
  const at = Math.max(0, Math.min(index, without.length))
  without.splice(at, 0, id)
  return without
}

/**
 * Drop `id` on `target`. Returns the next saved order and whether the pin must change
 * (`true` pin, `false` unpin, `null` leave it). An illegal drop (a group onto the pins, a chat into
 * another section) changes nothing.
 */
export function applyDrop(rows: readonly OrderRow[], id: string, target: DropTarget): { order: ChatOrder; pin: boolean | null } | null {
  const row = rows.find(item => item.id === id)
  if (!row) return null
  const order = visualOrder(rows)
  if (target.zone === 'pins') {
    if (row.kind !== 'bot') return null
    order.pins = pinIdsWithCoordinatorFirst(moveId(order.pins, id, target.index), rows)
    for (const section of SECTIONS) order.sections[section] = order.sections[section].filter(item => item !== id)
    return { order, pin: row.pinned ? null : true }
  }
  if (target.id !== naturalSection(row)) return null
  order.pins = order.pins.filter(item => item !== id)
  order.sections[target.id] = moveId(order.sections[target.id], id, target.index)
  return { order, pin: row.pinned ? false : null }
}

export type HomeSection<R> = { kind: 'section'; id: string; title: string; count: number; unread: number; collapsed: boolean }
export type HomeListItem<R> = HomeSection<R> | { kind: 'row'; row: R }

/** Drops the rows of a collapsed section and records how many of them are unread. */
export function collapseSections<R>(items: readonly ({ kind: 'section'; id: string; title: string; count: number } | { kind: 'row'; row: R })[], collapsed: ReadonlySet<string>, unreadOf: (row: R) => number): HomeListItem<R>[] {
  const unread = new Map<string, number>()
  let current: string | null = null
  for (const item of items) {
    if (item.kind === 'section') current = item.id
    else if (current) unread.set(current, (unread.get(current) ?? 0) + unreadOf(item.row))
  }
  const out: HomeListItem<R>[] = []
  let open = true
  for (const item of items) {
    if (item.kind === 'section') {
      open = !collapsed.has(item.id)
      out.push({ ...item, unread: unread.get(item.id) ?? 0, collapsed: !open })
    } else if (open) out.push(item)
  }
  return out
}

/** Layout of the home list, in points from the top of the scroll content, under a header of `header` points. */
export const ROW_HEIGHT = 74
export const SECTION_HEIGHT = 36
/** A pin tile's own height, then the gap before the next row of tiles. */
export const PIN_TILE = 88
export const PIN_GAP = 16
export const PIN_PAD_TOP = 12
export const PIN_PAD_BOTTOM = 8
export const PIN_COLUMNS = 4
export const EDGE_SCROLL = 72

export type Band =
  | { zone: 'pins'; top: number; height: number; count: number }
  | { zone: 'section'; id: SectionId; top: number; height: number; rows: number; collapsed: boolean }

export function pinGridHeight(count: number): number {
  if (count <= 0) return 0
  const rows = Math.ceil(count / PIN_COLUMNS)
  return PIN_PAD_TOP + rows * PIN_TILE + (rows - 1) * PIN_GAP + PIN_PAD_BOTTOM
}

export function listBands(header: number, pinCount: number, sections: readonly { id: SectionId; rows: number; collapsed: boolean }[]): Band[] {
  const bands: Band[] = []
  let y = header
  if (pinCount > 0) {
    const height = pinGridHeight(pinCount)
    bands.push({ zone: 'pins', top: y, height, count: pinCount })
    y += height
  }
  for (const section of sections) {
    const height = SECTION_HEIGHT + (section.collapsed ? 0 : section.rows * ROW_HEIGHT)
    bands.push({ zone: 'section', id: section.id, top: y, height, rows: section.rows, collapsed: section.collapsed })
    y += height
  }
  return bands
}

/** Which slot a finger at `contentY` (points from the scroll content's top) would drop into. */
export function dropAt(bands: readonly Band[], contentY: number, kind: 'bot' | 'group'): DropTarget | null {
  for (const band of bands) {
    if (contentY < band.top || contentY >= band.top + band.height) continue
    if (band.zone === 'pins') {
      if (kind !== 'bot') return null
      const row = Math.min(
        Math.max(0, Math.floor((contentY - band.top - PIN_PAD_TOP) / (PIN_TILE + PIN_GAP))),
        Math.max(0, Math.ceil(band.count / PIN_COLUMNS) - 1),
      )
      // The column comes from pinColumn; this is the first slot of the row.
      return { zone: 'pins', index: Math.min(band.count, row * PIN_COLUMNS) }
    }
    if (kind === 'group' && band.id !== 'groups') return null
    if (kind === 'bot' && band.id === 'groups') return null
    if (band.collapsed) return { zone: 'section', id: band.id, index: 0 }
    const index = Math.max(0, Math.min(band.rows, Math.floor((contentY - band.top - SECTION_HEIGHT) / ROW_HEIGHT)))
    return { zone: 'section', id: band.id, index }
  }
  return null
}

/**
 * Column inside the pin grid. `x` is points from the grid's left, `width` the grid's width.
 * The index is the row from `dropAt` plus this column, capped at the count.
 */
export function pinColumn(x: number, width: number): number {
  if (width <= 0) return 0
  const col = Math.floor((Math.max(0, x) / width) * PIN_COLUMNS)
  return Math.max(0, Math.min(PIN_COLUMNS - 1, col))
}

export function pinIndex(rowIndex: number, column: number, count: number): number {
  return Math.max(0, Math.min(count, rowIndex + column))
}

/** Where an insertion line sits, in points from the top of the scroll content. */
export function slotContentY(bands: readonly Band[], target: DropTarget): number | null {
  for (const band of bands) {
    if (target.zone === 'pins' && band.zone === 'pins') {
      const row = Math.floor(target.index / PIN_COLUMNS)
      return band.top + PIN_PAD_TOP + row * (PIN_TILE + PIN_GAP)
    }
    if (target.zone === 'section' && band.zone === 'section' && band.id === target.id) {
      return band.top + (band.collapsed ? 0 : SECTION_HEIGHT + target.index * ROW_HEIGHT)
    }
  }
  return null
}

/** -1 scrolls toward the top, 1 toward the bottom, 0 stays. `fingerY` is in the list's window. */
export function edgeScroll(fingerY: number, viewTop: number, viewHeight: number): -1 | 0 | 1 {
  if (fingerY < viewTop + EDGE_SCROLL) return -1
  if (fingerY > viewTop + viewHeight - EDGE_SCROLL) return 1
  return 0
}

export function parseChatOrder(raw: string | null): ChatOrder | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const record = value as { pins?: unknown; sections?: unknown }
    const pins = stringList(record.pins)
    const sections = record.sections && typeof record.sections === 'object' ? record.sections as Record<string, unknown> : {}
    return { pins, sections: { working: stringList(sections.working), bots: stringList(sections.bots), groups: stringList(sections.groups) } }
  } catch {
    return null
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
