/**
 * The project map (R-83, docs/design/project-map.md): a project's issues as a
 * route, laid out in lanes like `git log --graph`. Pure: no I/O, no clock.
 */

export interface MapIssueInput {
  id: string
  status: string
  createdAt: string
  updatedAt: string
  duplicateOfId: string | null
  parentId: string | null
  blockedByIds: readonly string[]
}

export interface MapGraph {
  /** Issue ids in creation order. */
  order: string[]
  rootId: string | null
  predecessor: Map<string, string | null>
  /** Successors in creation order. */
  children: Map<string, string[]>
  /** At a fork, the successor that continues in the parent's lane. */
  continues: Map<string, string>
  abandoned: Set<string>
  /** Every node in its subtree is abandoned. */
  branchAbandoned: Set<string>
  /** The lane-0 chain from the root. */
  mainLine: string[]
  /** The newest step on the main line that is not finished, else its last step. */
  currentId: string | null
}

export const ABANDONED_STATUSES: ReadonlySet<string> = new Set(['canceled', 'duplicate'])
const FINISHED_STATUSES: ReadonlySet<string> = new Set(['done', 'canceled', 'duplicate'])

const time = (value: string) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0 }

export function buildMapGraph(issues: readonly MapIssueInput[]): MapGraph {
  const byId = new Map(issues.map(issue => [issue.id, issue]))
  const created = (id: string) => time(byId.get(id)!.createdAt)
  const order = [...byId.keys()].sort((a, b) => created(a) - created(b) || (a < b ? -1 : a > b ? 1 : 0))
  const predecessor = new Map<string, string | null>()
  const reaches = (from: string, target: string) => {
    for (let at: string | null | undefined = from, guard = 0; at && guard <= order.length; at = predecessor.get(at), guard++) if (at === target) return true
    return false
  }
  let spineTail: string | null = null
  for (const id of order) {
    const issue = byId.get(id)!
    const onMap = (other: string | null | undefined): other is string => !!other && other !== id && byId.has(other)
    const blockers = issue.blockedByIds.filter(onMap).sort((a, b) => created(b) - created(a))
    const candidates = [issue.duplicateOfId, issue.parentId, ...blockers].filter(onMap)
    // A related issue hangs off the first relation that does not close a loop; an unrelated one follows the spine.
    const related = candidates.find(other => predecessor.has(other) ? !reaches(other, id) : true) ?? null
    predecessor.set(id, related)
    if (!related) { if (spineTail) predecessor.set(id, spineTail); spineTail = id }
  }
  const children = new Map<string, string[]>(order.map(id => [id, []]))
  for (const id of order) { const pred = predecessor.get(id); if (pred) children.get(pred)!.push(id) }
  const roots = order.filter(id => !predecessor.get(id))
  // Every root after the first is a late-created target of a relation; it joins the spine's start.
  const rootId = roots[0] ?? null
  for (const extra of roots.slice(1)) { predecessor.set(extra, rootId); children.get(rootId!)!.push(extra) }
  for (const list of children.values()) list.sort((a, b) => created(a) - created(b))

  const abandoned = new Set(order.filter(id => ABANDONED_STATUSES.has(byId.get(id)!.status)))
  const branchAbandoned = new Set<string>()
  const liveScore = new Map<string, number>()
  for (const id of [...order].reverse()) {
    const own = abandoned.has(id) ? -Infinity : time(byId.get(id)!.updatedAt)
    const kids = children.get(id)!
    liveScore.set(id, Math.max(own, ...kids.map(kid => liveScore.get(kid)!)))
    if (abandoned.has(id) && kids.every(kid => branchAbandoned.has(kid))) branchAbandoned.add(id)
  }
  const continues = new Map<string, string>()
  for (const id of order) {
    const kids = children.get(id)!
    if (kids.length < 2) continue
    // The most recently active subtree continues; among dead ones, the newest attempt.
    const chosen = kids.reduce((best, kid) => {
      const a = liveScore.get(kid)!, b = liveScore.get(best)!
      return a > b || (a === b && created(kid) >= created(best)) ? kid : best
    })
    continues.set(id, chosen)
  }
  const mainLine: string[] = []
  for (let at: string | undefined = rootId ?? undefined; at; at = nextInLane(at, children, continues)) mainLine.push(at)
  const unfinished = mainLine.filter(id => !FINISHED_STATUSES.has(byId.get(id)!.status))
  const currentId = unfinished.at(-1) ?? mainLine.at(-1) ?? null
  return { order, rootId, predecessor, children, continues, abandoned, branchAbandoned, mainLine, currentId }
}

function nextInLane(id: string, children: Map<string, string[]>, continues: Map<string, string>) {
  const kids = children.get(id)!
  return kids.length === 1 ? kids[0] : continues.get(id)
}

export type LineKind = 'main' | 'live' | 'abandoned'

export type MapRow =
  | { kind: 'node'; key: string; id: string; lane: number }
  | { kind: 'fork'; key: string; parentId: string; lane: number; chosenId: string; otherIds: string[]; parallel: boolean }
  | { kind: 'fold'; key: string; branchId: string; lane: number; count: number; abandoned: boolean; deep: boolean }

/** A lane's line from one row's centre to another's. */
export interface LaneLine { lane: number; from: number; to: number; kind: LineKind }
/** From a fork's diamond (row `from`, `fromLane`) out to a branch's first row. */
export interface BranchLine { fromLane: number; from: number; toLane: number; to: number; kind: LineKind }

export interface MapLayout {
  rows: MapRow[]
  lanes: LaneLine[]
  branches: BranchLine[]
  /** Deepest lane drawn (fold rows may sit one further right). */
  width: number
}

export interface LayoutOptions {
  /** Highest lane drawn: 2 on desktop, 1 on a phone. */
  maxLane: number
  folded?: ReadonlySet<string>
  foldAll?: boolean
  /** Draw only this branch, from lane 0 (a deep branch opened on its own). */
  focusId?: string | null
}

export function subtreeSize(graph: MapGraph, id: string): number {
  return 1 + graph.children.get(id)!.reduce((sum, kid) => sum + subtreeSize(graph, kid), 0)
}

export function layoutMap(graph: MapGraph, options: LayoutOptions): MapLayout {
  const rows: MapRow[] = []
  const lanes: LaneLine[] = []
  const branches: BranchLine[] = []
  let width = 0
  const start = options.focusId && graph.children.has(options.focusId) ? options.focusId : graph.rootId
  if (!start) return { rows, lanes, branches, width }
  const kindOf = (id: string, lane: number): LineKind => graph.branchAbandoned.has(id) ? 'abandoned' : lane === 0 && start === graph.rootId ? 'main' : 'live'
  const chain = (first: string, lane: number) => {
    width = Math.max(width, lane)
    const top = rows.length
    for (let at: string | undefined = first; at; at = nextInLane(at, graph.children, graph.continues)) {
      rows.push({ kind: 'node', key: at, id: at, lane })
      const kids = graph.children.get(at)!
      if (kids.length < 2) continue
      const chosenId = graph.continues.get(at)!
      const otherIds = kids.filter(kid => kid !== chosenId)
      const forkRow = rows.length
      rows.push({ kind: 'fork', key: `fork:${at}`, parentId: at, lane, chosenId, otherIds, parallel: otherIds.some(id => !graph.branchAbandoned.has(id)) })
      for (const other of otherIds) {
        const deep = lane + 1 > options.maxLane
        const fold = deep || options.foldAll || options.folded?.has(other)
        const begins = rows.length
        if (fold) {
          rows.push({ kind: 'fold', key: `fold:${other}`, branchId: other, lane: lane + 1, count: subtreeSize(graph, other), abandoned: graph.branchAbandoned.has(other), deep })
          width = Math.max(width, Math.min(lane + 1, options.maxLane))
        } else chain(other, lane + 1)
        branches.push({ fromLane: lane, from: forkRow, toLane: lane + 1, to: begins, kind: graph.branchAbandoned.has(other) ? 'abandoned' : 'live' })
      }
    }
    lanes.push({ lane, from: top, to: lastRowInLane(rows, top, lane), kind: kindOf(first, lane) })
  }
  chain(start, 0)
  return { rows, lanes, branches, width }
}

function lastRowInLane(rows: MapRow[], top: number, lane: number) {
  for (let index = rows.length - 1; index >= top; index--) if (rows[index].lane === lane && rows[index].kind === 'node') return index
  return top
}

/** Branch roots above `id`, outermost first: the breadcrumb of a branch opened on its own. */
export function branchAncestry(graph: MapGraph, id: string): string[] {
  const result: string[] = []
  for (let at = id, guard = 0; guard <= graph.order.length; guard++) {
    const pred = graph.predecessor.get(at)
    if (!pred) break
    if (graph.children.get(pred)!.length > 1 && graph.continues.get(pred) !== at) result.unshift(at)
    at = pred
  }
  return result
}

/** The path from the first step to `id`, as the rows and lines to highlight. */
export function pathHighlight(graph: MapGraph, layout: MapLayout, id: string | null): { rows: Set<number>; lanes: LaneLine[]; branches: BranchLine[] } {
  const rowsOut = new Set<number>()
  const lanesOut: LaneLine[] = []
  const branchesOut: BranchLine[] = []
  if (!id) return { rows: rowsOut, lanes: lanesOut, branches: branchesOut }
  const rowOf = new Map<string, number>()
  layout.rows.forEach((row, index) => { if (row.kind === 'node') rowOf.set(row.id, index); if (row.kind === 'fork') rowOf.set(row.key, index) })
  const path: string[] = []
  for (let at: string | null | undefined = id, guard = 0; at && guard <= graph.order.length; at = graph.predecessor.get(at), guard++) path.unshift(at)
  const shown = path.filter(step => rowOf.has(step))
  for (const step of shown) rowsOut.add(rowOf.get(step)!)
  for (let index = 1; index < shown.length; index++) {
    const previous = shown[index - 1], step = shown[index]
    const a = layout.rows[rowOf.get(previous)!], b = layout.rows[rowOf.get(step)!]
    if (a.lane === b.lane) { lanesOut.push({ lane: a.lane, from: rowOf.get(previous)!, to: rowOf.get(step)!, kind: 'live' }); continue }
    const fork = rowOf.get(`fork:${previous}`)
    if (fork === undefined) continue
    lanesOut.push({ lane: a.lane, from: rowOf.get(previous)!, to: fork, kind: 'live' })
    branchesOut.push({ fromLane: a.lane, from: fork, toLane: b.lane, to: rowOf.get(step)!, kind: 'live' })
  }
  return { rows: rowsOut, lanes: lanesOut, branches: branchesOut }
}
