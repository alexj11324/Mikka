/** Shared SWR identities. Keep reads, optimistic writes and push invalidations on the same key. */
export const chatKeys = {
  detail: (botId?: string | null) => botId ? ['coordinator-chat', botId] as const : 'coordinator-chat',
  metadata: (botId?: string | null) => ['coordinator-chat-metadata', botId ?? 'coordinator'] as const,
  list: (ownerId: string) => ['bot-chats', ownerId] as const,
}

export const threadKeys = {
  list: (ownerId: string) => ['threads', ownerId] as const,
  detail: (issueId: string | null, runId: string) => ['issue-thread', issueId, runId] as const,
}

export const taskRunKeys = {
  list: (ownerId: string) => ['task-runs', ownerId] as const,
}

export const issueKeys = {
  list: (ownerId: string, workspaceId: string) => ['issues', ownerId, workspaceId] as const,
  detail: (id: string) => ['issue', id] as const,
  versions: (id: string) => ['versions', id] as const,
  activityVersions: (id: string) => ['issue-activity-versions', id] as const,
  connections: (id: string) => ['issue-connections', id] as const,
  deleted: (id: string) => ['deleted-issue', id] as const,
  document: (id: string, clientId: number) => ['document-sync', id, clientId] as const,
}

export const botKeys = {
  all: () => 'bots' as const,
  list: (ownerId: string, workspaceId: string) => ['bots', ownerId, workspaceId] as const,
  groups: (ownerId: string, workspaceId: string) => ['bot-list-groups', ownerId, workspaceId] as const,
}

export const settingsKeys = {
  issuePrefix: () => 'settings:issue-prefix' as const,
  preferences: () => 'preferences' as const,
  password: () => 'account:password' as const,
  sessions: () => 'account:sessions' as const,
  savedLogins: () => 'account:saved-logins' as const,
  workspaceGeneral: (id: string) => ['workspace:general', id] as const,
  transferTargets: (id: string) => ['workspace:transfer-targets', id] as const,
  deletionImpact: (id: string) => ['workspace:deletion-impact', id] as const,
  computerPolicy: (id: string) => ['settings:computer-policy', id] as const,
  sharePolicy: (id: string) => ['settings:share-policy', id] as const,
  appPolicy: (id: string) => ['settings:app-policy', id] as const,
  environments: (id: string) => ['settings:environments', id] as const,
  secrets: (id: string) => ['settings:secrets', id] as const,
  e2bKey: (id: string) => ['settings:e2b-key', id] as const,
  usage: (id: string, month: string) => ['settings:usage', id, month] as const,
  billing: (id: string) => ['settings:billing', id] as const,
  creditBilling: (id: string) => ['credit-billing', id] as const,
  cardVerification: (id: string) => ['card-verification', id] as const,
  modelOrder: (id: string) => ['settings:model-order', id] as const,
  apiKeys: (id: string) => ['settings:api-keys', id] as const,
  subscriptions: (id: string) => ['settings:subscriptions', id] as const,
  subscriptionUsage: (id: string) => ['settings:subscription-usage', id] as const,
  subscriptionShare: (id: string) => ['settings:subscription-share', id] as const,
  paymentDesignation: (id: string) => ['settings:payment-designation', id] as const,
  creditShare: (id: string) => ['settings:credit-share', id] as const,
  tokens: (id?: string) => ['settings:tokens', id ?? ''] as const,
  archivedBots: (id: string) => ['settings:archived-bots', id] as const,
  mcpConnections: (id: string) => ['settings:mcp-connections', id] as const,
  memberSettings: (id?: string) => id ? `/api/workspace?workspace=${encodeURIComponent(id)}` : '/api/workspace',
  teamDirectory: (id?: string) => ['team-directory', id ?? null] as const,
  teamMembers: (id: string) => ['team-members', id] as const,
  audit: (id: string, filter: string, cursor: string | null) => ['settings:audit', id, filter, cursor] as const,
}
