import type { JSONContent } from '@tiptap/core'
import type { IssueMetadata } from './issue-metadata'

export type TaskRelationKind = 'child' | 'parent' | 'blockedBy' | 'blocks' | 'duplicate' | 'related'
type RelationTask = { id: string; status: string; metadata: Pick<IssueMetadata, 'parentId' | 'duplicateOfId' | 'blockedByIds' | 'relatedIds'> }
export const closedRelationStatus = (status: string) => ['done', 'canceled', 'duplicate'].includes(status)

/** Group an already authorized relation for display. A resolved block remains a related task. */
export function taskRelationKinds(task: RelationTask, row: RelationTask): TaskRelationKind[] {
  const kinds: TaskRelationKind[] = []
  if (task.id === row.id) return kinds
  if (row.metadata.parentId === task.id) kinds.push('child')
  if (task.metadata.parentId === row.id) kinds.push('parent')
  if (task.metadata.duplicateOfId === row.id) kinds.push('duplicate')
  const blockedBy = task.metadata.blockedByIds.includes(row.id)
  const blocks = row.metadata.blockedByIds.includes(task.id)
  if (blockedBy && !closedRelationStatus(row.status)) kinds.push('blockedBy')
  if (blocks && !closedRelationStatus(task.status)) kinds.push('blocks')
  if (task.metadata.relatedIds.includes(row.id) || row.metadata.relatedIds.includes(task.id)
    || (blockedBy && closedRelationStatus(row.status)) || (blocks && closedRelationStatus(task.status))) kinds.push('related')
  return kinds
}

export function createsIssueCycle(id: string, targets: string[], graph: Map<string, string[]>) {
  const seen = new Set<string>()
  const queue = [...targets]
  while (queue.length) {
    const next = queue.pop()!
    if (next === id) return true
    if (seen.has(next)) continue
    seen.add(next)
    queue.push(...(graph.get(next) ?? []))
  }
  return false
}

function canonicalDescription(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalDescription)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, entry]) => {
    if (entry === null || entry === undefined) return []
    const normalized = canonicalDescription(entry)
    if (key === 'attrs' && Object.keys(normalized as object).length === 0) return []
    return [[key, normalized]]
  }))
}

export function descriptionKey(content: JSONContent) {
  return JSON.stringify(canonicalDescription(content.content ?? []))
}

export function compareDescriptions(before: JSONContent, after: JSONContent) {
  const left = before.content ?? []
  const right = after.content ?? []
  const a = left.map(node => JSON.stringify(canonicalDescription(node)))
  const b = right.map(node => JSON.stringify(canonicalDescription(node)))
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  if (a.length * b.length > 250000) return { content: after, changes: descriptionKey(before) === descriptionKey(after) ? 0 : 1 }
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const content: JSONContent[] = []
  let i = 0, j = 0, changes = 0, changing = false
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { content.push(right[j]); i++; j++; changing = false }
    else {
      if (!changing) changes++
      changing = true
      const removed = i < a.length && (j >= b.length || table[i + 1][j] >= table[i][j + 1])
      const node = removed ? left[i++] : right[j++]
      content.push({ ...node, attrs: { ...node.attrs, historyChange: removed ? 'removed' : 'added', historyGroup: changes } })
    }
  }
  return { content: { type: 'doc', content }, changes }
}
