import { AsyncLocalStorage } from 'node:async_hooks'
/** Server-owned billing identity for non-Workflow model consumers. */
export const hostedBillingScope = new AsyncLocalStorage<{
  workspaceId: string
  ownerId?: string
  workspaceIds?: string[]
  /** Selected for one admission; preserved in the receipt independently from the source workspace. */
  billingAccountWorkspaceId?: string
  billingOrganizationId?: string | null
  creditShareOwnerId?: string
  actorId?: string | null
  projectId?: string | null
  threadId?: string | null
  runId?: string | null
  /** True only after server authorization established each resource binding. */
  attributionComplete?: boolean
}>()
