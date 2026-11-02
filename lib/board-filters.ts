/**
 * The board's two 「我」 filters (decision 2026-11-02-0302). 负责人 我: the task
 * is assigned to the person, or one of the person's own bots or Agents holds
 * it (work handed to my bot is my work). 我创建的: the person created it.
 */
export function personFilters(
  issue: { ownerId: string; metadata: { assignee?: { kind?: string; id: string } | null } },
  userId: string,
  mine: { agents: ReadonlySet<string>; heldByMyBot: boolean },
) {
  const assignee = issue.metadata.assignee
  return {
    assignee: assignee?.id === userId || (assignee?.kind === 'agent' && mine.agents.has(assignee.id)) || mine.heldByMyBot,
    creator: issue.ownerId === userId,
  }
}
