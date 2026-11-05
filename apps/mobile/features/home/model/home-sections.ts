/**
 * The home list's sections (#1408 Phase 2): the pinned bots on top as tiles, then 正在工作 for bots at work, then
 * Bot and 群聊, each newest first. A search lists every match in one run, without pins or sections.
 */
type Row = { kind: 'bot'; bot: { pinned?: boolean; coordinator?: boolean; working?: boolean } } | { kind: 'group' }

export type HomeItem<R> = { kind: 'section'; id: string; title: string; count: number } | { kind: 'row'; row: R }

export function homeSections<R extends Row>(rows: readonly R[], searching: boolean): { pinned: R[]; items: HomeItem<R>[] } {
  if (searching) return { pinned: [], items: rows.map(row => ({ kind: 'row', row })) }
  // Pin order is the order `rows` already has (the saved arrangement, or the Coordinator first when there is none).
  const pinned = rows.filter(row => row.kind === 'bot' && row.bot.pinned)
  const rest = rows.filter(row => !pinned.includes(row))
  const sections: [string, string, R[]][] = [
    ['working', '正在工作', rest.filter(row => row.kind === 'bot' && row.bot.working)],
    ['bots', 'Bot', rest.filter(row => row.kind === 'bot' && !row.bot.working)],
    ['groups', '群聊', rest.filter(row => row.kind === 'group')],
  ]
  const items = sections.flatMap(([id, title, list]): HomeItem<R>[] => list.length
    ? [{ kind: 'section', id, title, count: list.length }, ...list.map(row => ({ kind: 'row' as const, row }))]
    : [])
  return { pinned, items }
}
