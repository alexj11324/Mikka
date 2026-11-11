import { z } from 'zod'

/** Pure non-secret model descriptors shared with durable serialization.
 * Provider resolution and credential access stay in subscription-model-snapshot. */
export const hostedSubscriptionSnapshotSchema = z.strictObject({
  coordinator: z.literal(true).optional(),
  type: z.literal('subscription'), bindingId: z.uuid(), ownerId: z.string().min(1),
  consumerId: z.uuid(), workspaceId: z.uuid(), connectionId: z.uuid(),
  /** Set when the bot runs on another member's shared subscription (allowOthers): the run's owner. `ownerId` is the subscription's. */
  runOwnerId: z.string().min(1).optional(),
  connectionRevision: z.number().int().positive(), modelId: z.string().min(1).max(128),
  route: z.enum(['codex_cpa', 'claude_cpa', 'openai_siwc']),
  afterPoints: z.literal(true).optional(),
})
export type HostedSubscriptionSnapshot = z.infer<typeof hostedSubscriptionSnapshotSchema>
/**
 * A bot chat frozen on a model an API key or custom provider serves (C22).
 * `ownerId` is the bot's owner; the key may be a teammate's shared one. No key material.
 */
export const hostedApiKeySnapshotSchema = z.strictObject({
  coordinator: z.literal(true).optional(),
  type: z.literal('api_key'), keyId: z.uuid(), ownerId: z.string().min(1),
  consumerId: z.uuid().optional(), workspaceId: z.uuid(), modelId: z.string().min(1).max(128),
  /** 订阅额度用完后，自动改用 API Key: the subscription this turn would have used, out of quota, and the person's own key it runs on instead. */
  afterQuota: z.strictObject({
    subscription: z.enum(['claude', 'codex']), plan: z.string().max(60).nullable(),
    keyProvider: z.string().min(1).max(20), keyName: z.string().max(60).nullable(),
  }).optional(),
  /** 点数不足时改用: Mikka 默认 had no points here, so this turn runs on the next model in 优先使用的模型. Also on a subscription snapshot. */
  afterPoints: z.literal(true).optional(),
})
export type HostedApiKeySnapshot = z.infer<typeof hostedApiKeySnapshotSchema>
export const hostedModelSelectionSchema = z.discriminatedUnion('type', [hostedSubscriptionSnapshotSchema, hostedApiKeySnapshotSchema])
export type HostedModelSelection = z.infer<typeof hostedModelSelectionSchema>
export interface HostedRuntimeSnapshot {
  harness: string
  model: string | null
  modelSelection?: HostedModelSelection
}
/** The bot scope a frozen selection belongs to. */
export const selectionScope = (selection: HostedModelSelection): HostedModelScope => ({
  ownerId: selection.type === 'subscription' ? selection.runOwnerId ?? selection.ownerId : selection.ownerId,
  botId: selection.coordinator ? null : selection.consumerId ?? null,
  workspaceId: selection.workspaceId,
})
export interface HostedModelScope { ownerId: string; botId: string | null; workspaceId: string | null }
