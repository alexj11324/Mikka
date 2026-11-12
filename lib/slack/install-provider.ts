import { createHash, randomBytes } from 'node:crypto'
import { withBasePath } from '../base-path'

export const SLACK_STATE_COOKIE = 'mikka-slack-install'
export const SLACK_CALLBACK_PATH = withBasePath('/api/integrations/slack/callback')
export const SLACK_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'users:read',
  'channels:read',
  'channels:history',
  'groups:read',
  'groups:history',
  'im:read',
  'im:history',
] as const
export const slackTeamId = (v: unknown): v is string => typeof v === 'string' && /^T[A-Z0-9]{1,40}$/.test(v)
export const slackUserId = (v: unknown): v is string => typeof v === 'string' && /^[UW][A-Z0-9]{1,40}$/.test(v)
export const selectableSlackChannel = (v: unknown): v is string =>
  typeof v === 'string' && /^[CG][A-Z0-9]{1,40}$/.test(v)
export const stateHash = (value: string) => createHash('sha256').update(value).digest('hex')
export const createState = () => randomBytes(32).toString('base64url')

export function installPlatform(env: NodeJS.ProcessEnv = process.env) {
  const appId = env.SLACK_APP_ID,
    clientId = env.SLACK_CLIENT_ID,
    secret = env.SLACK_CLIENT_SECRET
  if (!appId || !/^A[A-Z0-9]+$/.test(appId) || !clientId || !secret || !env.BETTER_AUTH_URL) return null
  const base = new URL(env.BETTER_AUTH_URL)
  if (
    base.username ||
    base.password ||
    (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  )
    return null
  return { appId, clientId, secret, redirect: new URL(SLACK_CALLBACK_PATH, base.origin).href }
}
export type InstallPlatform = NonNullable<ReturnType<typeof installPlatform>>

export function authorizeSlack(platform: InstallPlatform, state: string) {
  const url = new URL('https://slack.com/oauth/v2/authorize')
  url.search = new URLSearchParams({
    client_id: platform.clientId,
    scope: SLACK_SCOPES.join(','),
    redirect_uri: platform.redirect,
    state,
  }).toString()
  return url.href
}

type SlackResult = { ok?: boolean; error?: string } & Record<string, unknown>
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

async function post(
  operation: string,
  body: URLSearchParams,
  authorization: string,
  send: typeof fetch,
  signal = AbortSignal.timeout(8000),
): Promise<SlackResult> {
  const response = await send('https://slack.com/api/' + operation, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  })
  if (!response.ok) throw new Error('slackProviderUnavailable')
  return object(await response.json()) as SlackResult
}
export async function redeemSlackCode(platform: InstallPlatform, code: string, send = fetch) {
  const oauth = await post(
    'oauth.v2.access',
    new URLSearchParams({ code, redirect_uri: platform.redirect }),
    'Basic ' + Buffer.from(platform.clientId + ':' + platform.secret).toString('base64'),
    send,
  )
  const team = object(oauth.team),
    user = object(oauth.authed_user)
  const scopes = typeof oauth.scope === 'string' ? oauth.scope.split(',') : []
  if (
    oauth.ok !== true ||
    oauth.app_id !== platform.appId ||
    oauth.token_type !== 'bot' ||
    oauth.is_enterprise_install === true ||
    !slackTeamId(team.id) ||
    !slackUserId(user.id) ||
    !slackUserId(oauth.bot_user_id) ||
    oauth.bot_user_id === user.id ||
    typeof team.name !== 'string' ||
    !team.name.trim() ||
    typeof oauth.access_token !== 'string' ||
    !oauth.access_token ||
    !SLACK_SCOPES.every((scope) => scopes.includes(scope))
  )
    throw new Error('slackInstallNotAuthorized')
  const identity = await post('auth.test', new URLSearchParams(), 'Bearer ' + oauth.access_token, send)
  if (
    identity.ok !== true ||
    identity.team_id !== team.id ||
    identity.user_id !== oauth.bot_user_id ||
    typeof identity.bot_id !== 'string' ||
    !/^B[A-Z0-9]+$/.test(identity.bot_id)
  )
    throw new Error('slackInstallNotAuthorized')
  return {
    appId: platform.appId,
    teamId: team.id,
    teamName: team.name.slice(0, 200),
    slackUserId: user.id,
    botUserId: oauth.bot_user_id,
    credential: readCredential(oauth),
    scopes,
  }
}
export type SlackGrant = Awaited<ReturnType<typeof redeemSlackCode>>

async function conversations(token: string, user: string | undefined, send: typeof fetch, signal: AbortSignal) {
  const rows: { id: string; name: string }[] = [],
    seen = new Set<string>()
  let cursor = ''
  do {
    const result = await post(
      'users.conversations',
      new URLSearchParams({
        types: 'public_channel,private_channel',
        exclude_archived: 'true',
        limit: '200',
        ...(user ? { user } : {}),
        ...(cursor ? { cursor } : {}),
      }),
      'Bearer ' + token,
      send,
      signal,
    )
    if (result.ok !== true || !Array.isArray(result.channels)) throw new Error('slackProviderUnavailable')
    for (const item of result.channels) {
      const channel = object(item)
      if (
        channel.is_archived !== true &&
        channel.is_ext_shared !== true &&
        selectableSlackChannel(channel.id) &&
        typeof channel.name === 'string'
      )
        rows.push({ id: channel.id, name: channel.name.slice(0, 100) })
    }
    const next = object(result.response_metadata).next_cursor
    cursor = typeof next === 'string' ? next : ''
    if (cursor && seen.has(cursor)) throw new Error('slackProviderUnavailable')
    seen.add(cursor)
  } while (cursor)
  return rows
}

export async function slackChannels(token: string, user: string, send = fetch) {
  if (!slackUserId(user)) throw new Error('slackInstallNotAuthorized')
  const deadline = AbortSignal.timeout(12000)
  const [bot, member] = await Promise.all([
    conversations(token, undefined, send, deadline),
    conversations(token, user, send, deadline),
  ])
  const visible = new Set(member.map((channel) => channel.id))
  return bot.filter((channel) => visible.has(channel.id))
}

export type SlackCredential = { token: string; refresh: string | null; expires: number | null }

function readCredential(data: SlackResult): SlackCredential {
  if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('slackInstallNotAuthorized')
  if (data.expires_in === undefined && data.refresh_token === undefined)
    return { token: data.access_token, refresh: null, expires: null }
  if (
    typeof data.refresh_token !== 'string' ||
    !data.refresh_token ||
    typeof data.expires_in !== 'number' ||
    !Number.isSafeInteger(data.expires_in) ||
    data.expires_in <= 0
  )
    throw new Error('slackInstallNotAuthorized')
  return { token: data.access_token, refresh: data.refresh_token, expires: Date.now() + data.expires_in * 1000 }
}

export async function rotateSlack(platform: InstallPlatform, refresh: string, team: string, bot: string, send = fetch) {
  const data = await post(
    'oauth.v2.access',
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
    'Basic ' + Buffer.from(platform.clientId + ':' + platform.secret).toString('base64'),
    send,
  )
  if (
    data.ok !== true ||
    data.token_type !== 'bot' ||
    data.app_id !== platform.appId ||
    object(data.team).id !== team ||
    data.bot_user_id !== bot
  )
    throw new Error('slackInstallNotAuthorized')
  const result = readCredential(data)
  if (!result.refresh || !result.expires) throw new Error('slackInstallNotAuthorized')
  return result
}

export async function uninstallSlack(platform: InstallPlatform, token: string, send = fetch) {
  const result = await post(
    'apps.uninstall',
    new URLSearchParams({ client_id: platform.clientId, client_secret: platform.secret }),
    'Bearer ' + token,
    send,
  )
  return result.ok === true
}
