/**
 * The board's two 「我」 filters (decision 2026-11-02-0302): 负责人 我 is the
 * task's assignee and nothing else; 我创建的 is the person who created it.
 */
export function personFilters(issue: { ownerId: string; metadata: { assignee?: { id: string } | null } }, userId: string) {
  return { assignee: issue.metadata.assignee?.id === userId, creator: issue.ownerId === userId }
}
