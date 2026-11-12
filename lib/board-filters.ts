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
