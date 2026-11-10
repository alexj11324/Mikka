import { AsyncLocalStorage } from 'node:async_hooks'
/** Server-owned billing identity for non-Workflow model consumers. */
export const hostedBillingScope = new AsyncLocalStorage<{
  workspaceId: string
  ownerId?: string
  /** The authenticated person who initiated this execution, separately from its resource owner. */
  actorId?: string | null
  workspaceIds?: string[]
  /** Selected for one admission; preserved in the receipt independently from the source workspace. */
  billingAccountWorkspaceId?: string
  billingOrganizationId?: string | null
  creditShareOwnerId?: string
  projectId?: string | null
  threadId?: string | null
  runId?: string | null
  /** True only after server authorization established each resource binding. */
  attributionComplete?: boolean
}>()
