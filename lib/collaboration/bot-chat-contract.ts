import type { HostedApiKeySnapshot } from '../subscription-model-snapshot'

export interface BotChatContributionPolicy {
  collaborative: boolean
  canReply: boolean
  reason?: string
  modelName?: string
  billingOrganizationId?: string
  maxModelCallsPerTurn?: number
  maxRepliesPerDay?: number
  maxOutputTokens?: number
}
export interface BotChatSubmissionAuthority {
  eventId: string
  ownerId: string
  actorId: string
  botId: string
  workspaceId: string
  principalKind: 'session' | 'pat' | 'oauth'
  principalId: string
  mode: 'comment' | 'reply'
  contextIsolation: 'private' | 'shared_clean'
  fingerprint: string
  modelSnapshot: HostedApiKeySnapshot | null
  organizationId: string | null
  modelPolicyRevision: number | null
  maxModelCalls: number
  maxOutputTokens: number
  expiresAt: Date | string
}
/** Only this host-created reference crosses durable Workflow boundaries. */
export type SharedBotChatScope = { eventId: string; botId: string }
export const SHARED_BOT_CHAT_TOOLS = ['web_search', 'list_issues', 'get_issue', 'list_runs', 'get_run'] as const
