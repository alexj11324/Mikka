export type FactoryIssueScope = { userId: string; scope: string; scopeVersion: number; workspaceId?: string | null; ownershipState?: string }

/** Immutable tenant identity is separate from the provider publication
 * generation. Current membership, deletion and source checks also apply. */
export function factoryScopeAllows(task: { userId: string; scopeVersion?: number | null; workspaceId?: string | null }, issue: FactoryIssueScope | undefined) {
  return Boolean(issue?.ownershipState === 'bound' && issue.workspaceId && task.workspaceId === issue.workspaceId)
}
