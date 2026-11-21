import { z } from 'zod'

/** Internal Coordinator policy, independent of the frozen model and effort. */
export const subscriptionModelRequestPolicySchema = z.strictObject({
  codexServiceTier: z.literal('priority').optional(),
})
export type SubscriptionModelRequestPolicy = z.infer<typeof subscriptionModelRequestPolicySchema>

export interface SubscriptionCatalogueModel {
  id: string
  name?: string
  prioritySupported?: boolean
}
export interface SubscriptionModelCatalogue {
  revision: number | string
  models: string[]
  priorityVersion?: 1
  prioritySupport?: Record<string, boolean>
}
export type CodexPrioritySupport = 'supported' | 'unsupported' | 'unknown'

/** Only the current credential epoch's advertised capability can enable Fast.
 * This projection reuses the fresh access read; it never probes the provider. */
export function codexPrioritySupport(catalogue: unknown, revision: number, modelId: string): CodexPrioritySupport {
  if (!catalogue || typeof catalogue !== 'object' || Array.isArray(catalogue)) return 'unknown'
  const value = catalogue as Partial<SubscriptionModelCatalogue>
  if (value.priorityVersion !== 1 || !Number.isSafeInteger(revision) || revision < 1
    || (typeof value.revision !== 'number' && typeof value.revision !== 'string') || Number(value.revision) !== revision
    || !Array.isArray(value.models) || !value.models.includes(modelId)
    || !value.prioritySupport || typeof value.prioritySupport !== 'object' || Array.isArray(value.prioritySupport)
    || !Object.hasOwn(value.prioritySupport, modelId)) return 'unknown'
  return value.prioritySupport[modelId] === true ? 'supported' : value.prioritySupport[modelId] === false ? 'unsupported' : 'unknown'
}
