import type { IssueMetadata } from './issue-metadata'

/** The visible work owner is the named member, or the task’s execution delegate when it has no member. */
export function boardTaskOwner(metadata: Pick<IssueMetadata, 'assignee' | 'delegate'>) {
  return metadata.assignee ?? metadata.delegate
}

/**
 * Responsibility and delegation are separate (#1687). A bot holding a task
 * never makes its owner the human assignee. Following is an explicit relation.
 */
export function personFilters(
  issue: { ownerId: string; metadata: { assignee?: { kind?: string; id: string } | null; subscriberUserIds?: readonly string[] } },
  userId: string,
  _mine: { agents: ReadonlySet<string>; heldByMyBot: boolean },
) {
  const assignee = issue.metadata.assignee
  return {
    assignee: assignee?.kind === 'member' && assignee.id === userId,
    following: issue.metadata.subscriberUserIds?.includes(userId) ?? false,
    creator: issue.ownerId === userId,
  }
}

/** Old, account-scoped Board settings stored display names. Resolve a saved
 * name to all matching visible project identities, preserving its old meaning
 * even for duplicate names. An unresolved name must continue filtering. */
export function boardProjectFilters(values: readonly string[] | undefined, projects: ReadonlyMap<string, string>) {
  if (!values) return undefined
  return [...new Set(values.flatMap(value => {
    if (value === 'none' || projects.has(value)) return [value]
    const ids = [...projects].filter(([, name]) => name === value).map(([id]) => id)
    return ids.length ? ids : [value]
  }))]
}

/** The key the Board's filters are kept under. `board:filters` held the retired
 * default 「负责人：我」, which hid every task a bot holds (2026-11-13-1405). */
export const BOARD_FILTERS_KEY = 'board:filters:v2'
export const LEGACY_BOARD_FILTERS_KEY = 'board:filters'

/**
 * Filters saved under the old key. A value equal to the retired default was
 * never the person's choice and is dropped, so the Board shows every task; any
 * other saved selection is kept as it was. Empty fields do not count.
 */
export function migrateBoardFilters<T extends Partial<Record<string, string[]>>>(legacy: T | null | undefined): T | null {
  if (!legacy || typeof legacy !== 'object') return null
  const chosen = Object.entries(legacy).filter(([, values]) => Array.isArray(values) && values.length)
  if (!chosen.length) return null
  const [field, values] = chosen[0]!
  if (chosen.length === 1 && field === 'assignee' && values!.length === 1 && values![0] === 'me') return null
  return legacy
}
