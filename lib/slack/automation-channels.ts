import 'server-only'
import { slackReactionName } from '@/lib/schedules/contract'
import { pool } from '@/lib/db'
import { installationCredential } from './installation-store'

export type SlackChannelOption = { id: string; name: string; private: boolean }
const PAGES = 5

/**
 * 自动化 Slack triggers: the channels the workspace's Slack installation can see (public ones and the private ones the
 * Bot was invited to), for a person who is a member of that installation; null when they are not, or nothing is installed.
 * Slack itself unreachable throws.
 */
export async function slackInstallationChannels(app: string, owner: string, workspace: string, send: typeof fetch = fetch): Promise<SlackChannelOption[] | null> {
  let token: string
  try { token = await installationCredential(pool, { app, owner, workspace }, { settings: true }) }
  catch (error) { if (error instanceof Error && error.message === 'slackInstallNotAuthorized') return null; throw error }
  const channels: SlackChannelOption[] = []
  let cursor = ''
  for (let page = 0; page < PAGES; page++) {
    const url = new URL('https://slack.com/api/conversations.list')
    url.search = new URLSearchParams({ types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200', ...(cursor ? { cursor } : {}) }).toString()
    const response = await send(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
    const body = await response.json() as { ok?: boolean; error?: string; channels?: { id?: unknown; name?: unknown; is_private?: unknown }[]; response_metadata?: { next_cursor?: string } }
    if (!response.ok || !body.ok) throw new Error(`slackChannelsUnavailable:${body.error ?? response.status}`)
    for (const channel of body.channels ?? []) {
      if (typeof channel.id === 'string' && typeof channel.name === 'string') channels.push({ id: channel.id, name: channel.name, private: channel.is_private === true })
    }
    cursor = body.response_metadata?.next_cursor ?? ''
    if (!cursor) break
  }
  return channels.sort((a, b) => a.name.localeCompare(b.name))
}

/** Only custom names are returned by Slack, including aliases. Standard reaction names remain valid without a grant. */
export async function slackInstallationEmojis(app: string, owner: string, workspace: string, send: typeof fetch = fetch): Promise<string[]> {
  let token: string
  try {
    token = await installationCredential(pool, { app, owner, workspace }, { settings: true, requiredScope: 'emoji:read' })
  } catch (error) {
    if (error instanceof Error && error.message === 'slackInstallNotAuthorized') return []
    throw error
  }
  const response = await send('https://slack.com/api/emoji.list', {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json() as { ok?: boolean; error?: string; emoji?: Record<string, unknown> }
  if (response.ok && body.error === 'missing_scope') return []
  if (!response.ok || !body.ok || !body.emoji || typeof body.emoji !== 'object' || Array.isArray(body.emoji)) {
    throw new Error('slackEmojisUnavailable')
  }
  return Object.keys(body.emoji).filter(name => slackReactionName.safeParse(name).success).sort()
}
