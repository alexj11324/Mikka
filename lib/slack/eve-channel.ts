import { slackChannel, type SlackChannel, type SlackChannelConfig, type SlackInboundMessageContext, type SlackMessage } from 'eve/channels/slack'
import type { RouteHandlerArgs } from 'eve/channels'
import type { SlackChannelState } from 'eve/channels/slack'
import { slackConfig } from './config'
import { slackRouting, slackInboundIdentity, slackAddress } from './eve-routing'
import { validSlackSignature } from './webhook'
import type { SlackScope } from './eve-ambient'

const GUIDANCE = 'Reply only in this Slack thread. Do not use or disclose the private Mikka chat, personal memories or unrelated integration content. Use ordinary titles and ids; Slack does not render Mikka source chips. If this message is not intended for you or you cannot add useful help, call no_reply. A dispatched task completes separately; do not promise automatic Slack completion updates.'

export interface SlackChannelDependencies {
  env?: () => Record<string, string | undefined>
  resolveScope?: (ownerId: string, workspaceId: string | null) => Promise<SlackScope>
  shouldJoin?: (scope: SlackScope, text: string) => Promise<boolean>
  api?: SlackChannelConfig['api']
  recordSource?: (scope: SlackScope, message: SlackMessage) => Promise<string>
}

async function defaultScope(ownerId: string, workspaceId: string | null): Promise<SlackScope> {
  const [{ coordinatorBot }, { requireTaskWorkspace }] = await Promise.all([import('../coordinator/coordinator-bot'), import('../task-workspace')])
  const bot = await coordinatorBot(ownerId, workspaceId)
  await requireTaskWorkspace(ownerId, bot.workspaceId)
  return { ownerId, ...bot }
}

const authFor = (scope: SlackScope, slackUserId: string) => ({
  authenticator: 'mikka', principalType: 'user', principalId: scope.ownerId,
  attributes: { botId: scope.botId, workspaceId: scope.workspaceId, surface: 'slack', slackUserId },
})

/** Portable native eve Slack channel. Routing/auth are Mikka's boundary; eve owns the agent and delivery. */
export function createMikkaSlackChannel(dependencies: SlackChannelDependencies = {}): SlackChannel {
  const env = dependencies.env ?? (() => process.env)
  const resolveScope = dependencies.resolveScope ?? defaultScope
  const join = dependencies.shouldJoin ?? (async (scope, text) => (await import('./eve-ambient')).shouldJoinSlack(scope, text))
  const recordSource = dependencies.recordSource ?? (async (scope, message) => (await import('./eve-source')).recordSlackSource(scope, message))
  const config = () => slackConfig(env())
  async function onMessage(ctx: SlackInboundMessageContext, message: SlackMessage) {
    const current = config(), routing = slackRouting(env())
    const user = message.author
    if (!current || !routing || !user || user.isBot !== false || user.userId === current.SLACK_BOT_USER_ID || message.teamId !== current.SLACK_TEAM_ID || !Object.hasOwn(current.SLACK_USER_BINDINGS, user.userId) || ctx.edit) return null
    const scope = await resolveScope(current.SLACK_USER_BINDINGS[user.userId], routing.workspaces[message.channelId] ?? null)
    const admit = async (ambient = false) => ({ auth: { ...authFor(scope, user.userId), attributes: {
      ...authFor(scope, user.userId).attributes, sourceEventId: await recordSource(scope, message),
    } }, ...(ambient ? { status: 'deferred' as const } : {}), guidance: GUIDANCE })
    if (ctx.isBotMentioned() || message.raw.channel_type === 'im') return admit()
    if (!routing.watched.includes(message.channelId)) return null
    // Screening happens before native send(), so a skip neither interrupts a turn nor posts status.
    try { return await join(scope, message.text) ? await admit(true) : null }
    catch { return null }
  }
  const native = slackChannel({
    ...(dependencies.api ? { api: dependencies.api } : {}),
    credentials: {
      botToken({ teamId }) {
        const current = config()
        if (!current || teamId && teamId !== current.SLACK_TEAM_ID) throw new Error('slackUnavailable')
        return current.SLACK_BOT_TOKEN
      },
      webhookVerifier(request, body) {
        const current = config()
        if (!current || !validSlackSignature(body, request.headers.get('x-slack-request-timestamp'), request.headers.get('x-slack-signature'), current.SLACK_SIGNING_SECRET)) throw new Error('slackSignatureInvalid')
        return true
      },
    },
    botName: 'Mikka', turnPolicy: 'queue', uploadPolicy: 'disabled',
    // Only this authorized Slack thread is imported. Web/private Mikka transcripts never enter it.
    threadContext: { since: 'last-agent-reply' },
    onMessage,
    async onAnswers(ctx, submission) {
      const current = config(), routing = slackRouting(env())
      const userId = submission.user.id
      if (!current || !routing || ctx.slack.teamId !== current.SLACK_TEAM_ID || !Object.hasOwn(current.SLACK_USER_BINDINGS, userId)) return null
      return { auth: authFor(await resolveScope(current.SLACK_USER_BINDINGS[userId], routing.workspaces[ctx.slack.channelId] ?? null), userId) }
    },
  })
  return {
    ...native,
    routes: native.routes.map(route => route.transport === 'websocket' ? route : ({
      ...route,
      async handler(request, args) {
        const current = config(), routing = slackRouting(env())
        if (!current || !routing) return new Response('Slack is not configured', { status: 503 })
        const raw = await request.clone().text()
        if (!validSlackSignature(raw, request.headers.get('x-slack-request-timestamp'), request.headers.get('x-slack-signature'), current.SLACK_SIGNING_SECRET)) return new Response('Invalid signature', { status: 401 })
        let payload: unknown
        try { payload = request.headers.get('content-type')?.includes('application/x-www-form-urlencoded') ? JSON.parse(new URLSearchParams(raw).get('payload') ?? 'null') : JSON.parse(raw) }
        catch { return new Response('Invalid JSON', { status: 400 }) }
        if (payload && typeof payload === 'object' && 'type' in payload && payload.type === 'url_verification' && 'challenge' in payload && typeof payload.challenge === 'string') return Response.json({ challenge: payload.challenge })
        const identity = slackInboundIdentity(current, payload)
        if (!identity) return new Response(null, { status: 204 })
        const scope = await resolveScope(identity.ownerId, routing.workspaces[identity.channelId] ?? null)
        const scoped: RouteHandlerArgs<SlackChannelState> = {
          ...args,
          from(address) {
            const source = args.from(slackAddress(scope.ownerId, scope.workspaceId, address))
            return { ...source, send: (message, options) => source.send(message, { ...options,
              ...(identity.eventId ? { idempotencyKey: `slack:${current.SLACK_TEAM_ID}:${identity.eventId}` } : {}) }) }
          },
          resolveSession: address => args.resolveSession(slackAddress(scope.ownerId, scope.workspaceId, address)),
        }
        return route.handler(request, scoped)
      },
    })),
  }
}
