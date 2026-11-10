import { AsyncLocalStorage } from 'node:async_hooks'
/** Server-owned billing identity for non-Workflow model consumers. */
export const hostedBillingScope = new AsyncLocalStorage<{
  workspaceId: string
  ownerId?: string
  /** The authenticated person who initiated this execution, separately from its resource owner. */
  actorId?: string
  workspaceIds?: string[]
}>()
