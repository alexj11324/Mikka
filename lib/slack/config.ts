import { z } from 'zod'

const configSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_APP_ID: z.string().regex(/^A[A-Z0-9]+$/),
  SLACK_TEAM_ID: z.string().regex(/^T[A-Z0-9]+$/),
  SLACK_BOT_USER_ID: z.string().regex(/^U[A-Z0-9]+$/),
  SLACK_USER_BINDINGS: z.string().transform((value, ctx) => {
    try { return JSON.parse(value) as unknown } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid Slack user bindings' })
      return z.NEVER
    }
  }).pipe(z.record(z.string().regex(/^U[A-Z0-9]+$/), z.string().min(1))),
})

export function slackConfig(env: Record<string, string | undefined>) {
  const parsed = configSchema.safeParse(env)
  return parsed.success ? parsed.data : null
}

/** Only the signed envelope's app/workspace and explicitly bound sender count. */
export function slackOwner(config: NonNullable<ReturnType<typeof slackConfig>>, payload: unknown) {
  if (!payload || typeof payload !== 'object') return null
  const envelope = payload as Record<string, unknown>
  if (envelope.api_app_id !== config.SLACK_APP_ID || envelope.team_id !== config.SLACK_TEAM_ID) return null
  const event = envelope.event as Record<string, unknown> | undefined
  if (envelope.type !== 'event_callback' || !event || event.type !== 'app_mention' || event.bot_id || event.subtype) return null
  if (typeof event.user !== 'string' || typeof event.text !== 'string') return null
  // Own keys only: a sender id like `constructor` must not reach Object.prototype.
  return Object.hasOwn(config.SLACK_USER_BINDINGS, event.user) ? config.SLACK_USER_BINDINGS[event.user] : null
}
