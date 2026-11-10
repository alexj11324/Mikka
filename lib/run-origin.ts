import { z } from 'zod'

/** Where a run was dispatched from (`agent_runs.origin`). Legacy rows stay
 * null (unknown); nothing here infers `web` for them. */
export const RUN_ORIGINS = ['web', 'slack', 'telegram', 'linear', 'github', 'api', 'automation', 'schedule', 'factory'] as const
export type RunOrigin = typeof RUN_ORIGINS[number]
export const runOriginSchema = z.enum(RUN_ORIGINS)

/** Opaque entry identifiers only: never message text, titles, prompts, URLs
 * or account data (lib/run-origin-writes.test.ts keeps them evidence-only). */
const opaqueId = z.string().trim().min(1).max(256)

export const runOriginRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slack'), teamId: opaqueId, channelId: opaqueId, threadTs: opaqueId }).strict(),
  z.object({ kind: z.literal('telegram'), chatId: opaqueId, messageId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ kind: z.literal('linear'), issueId: opaqueId, commentId: opaqueId.optional() }).strict(),
  z.object({ kind: z.literal('github'), repo: opaqueId, issueNumber: z.number().int().positive().optional(), pullRequest: z.number().int().positive().optional(), commentId: opaqueId.optional() }).strict(),
  z.object({ kind: z.literal('api'), clientId: opaqueId.optional(), workspaceId: opaqueId.optional() }).strict(),
  z.object({ kind: z.literal('automation'), automationId: opaqueId, runId: opaqueId.optional() }).strict(),
  z.object({ kind: z.literal('schedule'), scheduleId: opaqueId, occurrenceId: opaqueId }).strict(),
])
export type RunOriginRef = z.infer<typeof runOriginRefSchema>

/** A run's entry: `originRef.kind` must equal `origin`, so `web` and
 * `factory` carry no ref (there is no such kind). */
export const runOriginEntrySchema = z.object({ origin: runOriginSchema, originRef: runOriginRefSchema.nullish() }).strict()
  .superRefine((value, context) => {
    if (value.originRef != null && value.originRef.kind !== value.origin)
      context.addIssue({ code: 'custom', path: ['originRef', 'kind'], message: 'originRef.kind must equal origin' })
  })
export type RunOriginEntry = z.infer<typeof runOriginEntrySchema>

export interface ResolvedRunOrigin { origin: RunOrigin; originRef: RunOriginRef | null }

/** Explicit entry > the source run an automatic continuation copies > the
 * caller's default (`web` for the app). A stored legacy value that does not
 * parse is ignored rather than guessed. */
export function resolveRunOrigin(input: {
  explicit?: RunOriginEntry | null
  sourceRun?: { origin?: unknown; originRef?: unknown } | null
  defaultOrigin?: RunOrigin
}): ResolvedRunOrigin {
  if (input.explicit != null) {
    const explicit = runOriginEntrySchema.safeParse(input.explicit)
    if (!explicit.success) throw explicit.error
    return { origin: explicit.data.origin, originRef: explicit.data.originRef ?? null }
  }
  const origin = runOriginSchema.safeParse(input.sourceRun?.origin)
  if (origin.success) {
    const ref = runOriginRefSchema.safeParse(input.sourceRun?.originRef)
    return { origin: origin.data, originRef: ref.success && ref.data.kind === origin.data ? ref.data : null }
  }
  return { origin: input.defaultOrigin ?? 'web', originRef: null }
}

/** A stored/enum value, never a guess from `agent_runs.source`. */
export function readRunOrigin(value: unknown): RunOrigin | null {
  const parsed = runOriginSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function readRunOriginRef(value: unknown): RunOriginRef | null {
  const parsed = runOriginRefSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Telegram metadata as stored in a coordinator event payload: the chat id
 * and message id are opaque Slack/Telegram identifiers, not the text. */
export function telegramRunOriginRef(value: unknown): RunOriginRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const parsed = runOriginRefSchema.safeParse({ kind: 'telegram', chatId: source.threadId, messageId: source.messageId })
  return parsed.success ? parsed.data : null
}

/** A Slack event's own fields; never decoded from the chat adapter's thread id. */
export function slackRunOriginRef(value: unknown): RunOriginRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const event = value as Record<string, unknown>
  const teamId = typeof event.team_id === 'string' && event.team_id ? event.team_id : event.team
  const threadTs = typeof event.thread_ts === 'string' && event.thread_ts ? event.thread_ts : event.ts
  const parsed = runOriginRefSchema.safeParse({ kind: 'slack', teamId, channelId: event.channel, threadTs })
  return parsed.success ? parsed.data : null
}
