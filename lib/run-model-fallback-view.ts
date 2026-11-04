import { z } from 'zod'
import { providerFailureSchema, type ProviderFailure } from '@mikka/protocol/provider-failure'

const choiceSchema = z.strictObject({
  harness: z.enum(['claude_code', 'codex']),
  model: z.string().min(1).max(128),
  source: z.enum(['api_key', 'subscription']),
})
export type ModelFallbackChoice = z.infer<typeof choiceSchema>

/** Written only by the host on the source run, never accepted from a daemon's
 * report. Receipt fields stay on the server; the view exposes model labels. */
export const modelFallbackRecordSchema = z.strictObject({
  state: z.enum(['pending', 'switched', 'blocked', 'picked', 'stopped']),
  fallback: z.enum(['balance', 'unavailable']),
  from: choiceSchema,
  to: choiceSchema.optional(),
  retryRunId: z.uuid().optional(),
  nextDefinitionDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** URI-encoded entry keys: JSONB cannot store their literal NUL separators. */
  attempted: z.array(z.string()).optional(),
  reasons: z.array(z.strictObject({ choice: choiceSchema, reason: z.string().min(1).max(64) })).optional(),
  card: z.strictObject({
    title: z.string(), description: z.string(),
    options: z.array(z.strictObject({ value: z.string(), label: z.string(), action: z.enum(['modelSettings', 'e2bKey', 'connectServer']) })),
  }).optional(),
})
export type ModelFallbackRecord = z.infer<typeof modelFallbackRecordSchema>

export type ThreadModelFallbackView = {
  runId: string
  from: ModelFallbackChoice
  failure: ProviderFailure['kind']
  reasons?: ModelFallbackRecord['reasons']
  card?: ModelFallbackRecord['card']
} & ({ state: 'switched'; to: ModelFallbackChoice } | { state: 'blocked' | 'picked' })

/** A pending intent is not a switch. The read path must prove its committed
 * child belongs to this owner's chain or independent Factory check before
 * the UI can claim the model changed. */
export function projectModelFallback(runId: string, record: unknown, failure: unknown, chainRunIds: ReadonlySet<string>): ThreadModelFallbackView | null {
  if (!chainRunIds.has(runId)) return null
  const parsed = modelFallbackRecordSchema.safeParse(record)
  if (!parsed.success || parsed.data.state === 'pending' || parsed.data.state === 'stopped') return null
  const item = parsed.data
  const provider = providerFailureSchema.safeParse(failure)
  const view = {
    runId, from: item.from, failure: provider.success ? provider.data.kind : item.fallback === 'balance' ? 'balance' as const : 'unavailable' as const,
    ...(item.reasons ? { reasons: item.reasons } : {}), ...(item.card ? { card: item.card } : {}),
  }
  if (item.state === 'switched') {
    return item.to && item.retryRunId && chainRunIds.has(item.retryRunId) ? { ...view, state: 'switched', to: item.to } : null
  }
  return item.state === 'blocked' || item.state === 'picked' ? { ...view, state: item.state } : null
}
