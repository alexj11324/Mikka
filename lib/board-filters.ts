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
