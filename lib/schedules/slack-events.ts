import type { SlackTriggerEvent } from './contract'

/** One Slack event as an automation sees it. Every text field came from Slack and is data, not an instruction. */
export type SlackAutomationEvent = {
  source: 'slack'
  event: SlackTriggerEvent
  appId: string
  teamId: string
  channel: string
  /** The Slack user who wrote, mentioned or reacted. */
  user: string
  /** The message's `ts` (for a reaction, the message reacted to). */
  ts: string
  threadTs: string | null
  reaction: string | null
  /** A short excerpt of the message (none for a reaction). */
  text: string | null
}

type Json = Record<string, unknown>
const obj = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
const str = (value: unknown) => typeof value === 'string' && value ? value : null

/**
 * The automation event in one signed Slack Events delivery. Only a person's own message, mention or reaction counts:
 * a bot's message (Mikka's own included) or an edited, deleted or joined message yields none.
 */
export function slackAutomationEvents(payload: Json): SlackAutomationEvent[] {
  if (payload.type !== 'event_callback') return []
  const appId = str(payload.api_app_id), teamId = str(payload.team_id), event = obj(payload.event)
  if (!appId || !teamId || !event || event.bot_id || event.bot_profile) return []
  const user = str(event.user)
  if (!user) return []
  if (event.type === 'reaction_added') {
    const item = obj(event.item)
    const channel = str(item?.channel), ts = str(item?.ts)
    if (item?.type !== 'message' || !channel || !ts) return []
    return [{ source: 'slack', event: 'reaction_added', appId, teamId, channel, user, ts, threadTs: null, reaction: str(event.reaction), text: null }]
  }
  if (event.type !== 'message' && event.type !== 'app_mention') return []
  if (event.subtype !== undefined && event.subtype !== 'thread_broadcast') return []
  const channel = str(event.channel), ts = str(event.ts)
  if (!channel || !ts) return []
  const text = str(event.text)
  return [{ source: 'slack', event: event.type === 'app_mention' ? 'mention' : 'message', appId, teamId, channel, user, ts,
    threadTs: str(event.thread_ts), reaction: null, text: text ? text.slice(0, 2000) : null }]
}

/** Whether a Slack trigger takes an event: its event, one of its channels, and for a reaction any of its emoji. */
export function slackTriggerMatches(trigger: { event: string; channels: string[]; authors?: string[]; reactions?: string[] }, event: SlackAutomationEvent): boolean {
  if (trigger.event !== event.event || !trigger.channels.includes(event.channel)) return false
  if (trigger.authors?.length && !trigger.authors.includes(event.user)) return false
  return event.event !== 'reaction_added' || !trigger.reactions?.length || Boolean(event.reaction && trigger.reactions.includes(event.reaction))
}

/** The event as the Bot reads it: plain fields, marked as Slack's data it cannot close. */
export function describeSlackEvent(event: SlackAutomationEvent): string {
  const lines = [
    `event: ${event.event}`, `channel: ${event.channel}`, `user: ${event.user}`, `ts: ${event.ts}`,
    event.threadTs ? `thread: ${event.threadTs}` : null, event.reaction ? `reaction: ${event.reaction}` : null,
    event.text ? `text:\n${event.text.replace(/<\/slack_event/gi, '<\\/slack_event')}` : null,
  ].filter(Boolean)
  return `<slack_event>\n${lines.join('\n')}\n</slack_event>`
}
