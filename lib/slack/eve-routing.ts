import { z } from 'zod'
import { slackConfig } from './config'

const channelId = z.string().regex(/^[CDG][A-Z0-9]+$/)
const routingSchema = z.object({
  watched: z.array(channelId).max(100),
  workspaces: z.record(channelId, z.uuid()),
})

/** Channel selection is operational configuration, never supplied by Slack text. */
export function slackRouting(env: Record<string, string | undefined>) {
  try {
    const parsed = routingSchema.safeParse({
      watched: JSON.parse(env.SLACK_WATCHED_CHANNELS || '[]'),
      workspaces: JSON.parse(env.SLACK_CHANNEL_WORKSPACES || '{}'),
    })
    return parsed.success ? parsed.data : null
  } catch { return null }
}

export type SlackInboundIdentity = { ownerId: string; channelId: string; eventId?: string }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Only called after signature verification. Reject before eve acknowledges a mention. */
export function slackInboundIdentity(config: NonNullable<ReturnType<typeof slackConfig>>, payload: unknown): SlackInboundIdentity | null {
  const envelope = object(payload)
  const team = object(envelope.team)
  if (envelope.api_app_id !== config.SLACK_APP_ID || (envelope.team_id ?? team.id) !== config.SLACK_TEAM_ID) return null
  const event = object(envelope.event)
  let userId: unknown, channel: unknown
  if (envelope.type === 'event_callback') {
    if (!['app_mention', 'message'].includes(String(event.type)) || event.bot_id || event.subtype) return null
    if (typeof event.text !== 'string' || typeof envelope.event_id !== 'string' || !/^Ev[A-Za-z0-9]+$/.test(envelope.event_id)) return null
    userId = event.user
    channel = event.channel
  } else if (envelope.type === 'block_actions' || envelope.type === 'view_submission') {
    userId = object(envelope.user).id
    channel = object(envelope.channel).id ?? object(envelope.container).channel_id
    // The signed modal returns eve's channel coordinates. They still pass the
    // configured Mikka workspace binding; eve validates the actual request/answer.
    if (envelope.type === 'view_submission' && channel === undefined) {
      try { channel = object(JSON.parse(String(object(envelope.view).private_metadata))).channelId }
      catch { return null }
    }
  } else return null
  if (typeof userId !== 'string' || !Object.hasOwn(config.SLACK_USER_BINDINGS, userId) || userId === config.SLACK_BOT_USER_ID || !channelId.safeParse(channel).success) return null
  return { ownerId: config.SLACK_USER_BINDINGS[userId], channelId: channel as string,
    ...(typeof envelope.event_id === 'string' ? { eventId: envelope.event_id } : {}) }
}

/** Eve owns durable address/receipt dedupe; Mikka only adds the authenticated tenant. */
export const slackAddress = (ownerId: string, workspaceId: string, address: string) => JSON.stringify([ownerId, workspaceId, address])
