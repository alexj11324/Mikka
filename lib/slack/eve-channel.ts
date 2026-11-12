import {
  slackChannel,
  type SlackChannel,
  type SlackChannelConfig,
  type SlackInboundMessageContext,
  type SlackMessage,
} from 'eve/channels/slack'
import type { RouteHandlerArgs } from 'eve/channels'
import type { SlackChannelState } from 'eve/channels/slack'
import { signedCoordinates, signedRevocation } from './installed-routing'
import { activeSlackGrant, slackRequest } from './channel-scope'
import { nativeSlackToken, type SlackGrantScope } from './channel-grant'
import type { SlackBinding } from './installation-store'
import { validSlackSignature } from './webhook'
import type { SlackScope } from './eve-ambient'

const GUIDANCE =
  'Reply only in this Slack thread. Do not use or disclose the private Mikka chat, personal memories or unrelated integration content. Use ordinary titles and ids; Slack does not render Mikka source chips. If this message is not intended for you or you cannot add useful help, call no_reply. A dispatched task completes separately; do not promise automatic Slack completion updates.'

export interface SlackChannelDependencies {
  env?: () => Record<string, string | undefined>
  resolveScope?: (ownerId: string, workspaceId: string | null) => Promise<SlackScope>
  shouldJoin?: (scope: SlackScope, text: string) => Promise<boolean>
  api?: SlackChannelConfig['api']
  binding?: (app: string, team: string, sender: string) => Promise<SlackBinding | null>
  token?: (scope: SlackGrantScope) => Promise<string>
  memberRemoved?: (app: string, team: string, member: string, eventAt: number) => Promise<void>
  revoked?: (app: string, team: string, bot: string | null, eventAt: number) => Promise<void>
  recordSource?: (scope: SlackScope, message: SlackMessage) => Promise<string>
}

async function defaultScope(ownerId: string, workspaceId: string | null): Promise<SlackScope> {
  const [{ coordinatorBot }, { requireTaskWorkspace }] = await Promise.all([
    import('../coordinator/coordinator-bot'),
    import('../task-workspace'),
  ])
  const bot = await coordinatorBot(ownerId, workspaceId)
  await requireTaskWorkspace(ownerId, bot.workspaceId)
  return { ownerId, ...bot }
}

const authFor = (grant: SlackGrantScope) => ({
  authenticator: 'mikka',
  principalType: 'user',
  principalId: grant.ownerId,
  attributes: {
    botId: grant.botId,
    workspaceId: grant.workspaceId,
    surface: 'slack',
    slackUserId: grant.slackUserId,
    teamId: grant.teamId,
    installationId: grant.installationId,
    linkId: grant.linkId,
  },
})

/** Slack's signed envelope selects the installation; Mikka authorizes the human, and Eve owns delivery. */
export function createMikkaSlackChannel(dependencies: SlackChannelDependencies = {}): SlackChannel {
  const env = dependencies.env ?? (() => process.env)
  const resolveScope = dependencies.resolveScope ?? defaultScope
  const binding =
    dependencies.binding ??
    (async (app, team, sender) => {
      const [{ pool }, { signedSender }] = await Promise.all([import('../db'), import('./installation-store')])
      return signedSender(pool, app, team, sender)
    })
  const revoked =
    dependencies.revoked ??
    (async (app, team, bot, eventAt) => {
      const [{ pool }, { providerRevoked }] = await Promise.all([import('../db'), import('./installation-store')])
      await providerRevoked(pool, app, team, bot, eventAt)
    })
  const memberRemoved =
    dependencies.memberRemoved ??
    (async (app, team, member, eventAt) => {
      const [{ pool }, { providerMemberRemoved }] = await Promise.all([import('../db'), import('./installation-store')])
      await providerMemberRemoved(pool, app, team, member, eventAt)
    })
  const token = dependencies.token ?? nativeSlackToken
  const join =
    dependencies.shouldJoin ?? (async (scope, text) => (await import('./eve-ambient')).shouldJoinSlack(scope, text))
  const recordSource =
    dependencies.recordSource ??
    (async (scope, message) => (await import('./eve-source')).recordSlackSource(scope, message))
  async function onMessage(ctx: SlackInboundMessageContext, message: SlackMessage) {
    const grant = slackRequest.getStore(),
      user = message.author,
      app = env().SLACK_APP_ID
    if (
      !grant ||
      !app ||
      !user ||
      user.isBot !== false ||
      user.userId !== grant.slackUserId ||
      message.teamId !== grant.teamId ||
      ctx.edit
    )
      return null
    const latest = await binding(app, grant.teamId, grant.slackUserId)
    if (
      !latest ||
      latest.ownerId !== grant.ownerId ||
      latest.workspaceId !== grant.workspaceId ||
      latest.linkId !== grant.linkId ||
      latest.installationId !== grant.installationId
    )
      return null
    const scope = await resolveScope(grant.ownerId, grant.workspaceId)
    if (scope.botId !== grant.botId || scope.workspaceId !== grant.workspaceId) return null
    const admit = async (ambient = false) => ({
      auth: {
        ...authFor(grant),
        attributes: { ...authFor(grant).attributes, sourceEventId: await recordSource(scope, message) },
      },
      ...(ambient ? { status: 'deferred' as const } : {}),
      guidance: GUIDANCE,
    })
    if (ctx.isBotMentioned() || message.raw.channel_type === 'im') return admit()
    if (!latest.watched.includes(message.channelId)) return null
    try {
      return (await join(scope, message.text)) ? await admit(true) : null
    } catch {
      return null
    }
  }
  const native = slackChannel({
    ...(dependencies.api ? { api: dependencies.api } : {}),
    credentials: {
      async botToken({ teamId }) {
        const grant = activeSlackGrant()
        if (!grant || !teamId || teamId !== grant.teamId) throw new Error('slackInstallNotAuthorized')
        return token(grant)
      },
      webhookVerifier(request, body) {
        const signing = env().SLACK_SIGNING_SECRET
        if (
          !signing ||
          !validSlackSignature(
            body,
            request.headers.get('x-slack-request-timestamp'),
            request.headers.get('x-slack-signature'),
            signing,
          )
        )
          throw new Error('slackSignatureInvalid')
        return true
      },
    },
    botName: 'Mikka',
    turnPolicy: 'queue',
    uploadPolicy: 'disabled',
    // Only this authorized Slack thread is imported. Web/private Mikka transcripts never enter it.
    threadContext: { since: 'last-agent-reply' },
    onMessage,
    async onAnswers(ctx, submission) {
      const grant = slackRequest.getStore()
      if (!grant || submission.user.id !== grant.slackUserId || ctx.slack.teamId !== grant.teamId) return null
      const app = env().SLACK_APP_ID,
        fresh = app && (await binding(app, grant.teamId, grant.slackUserId))
      if (
        !fresh ||
        fresh.ownerId !== grant.ownerId ||
        fresh.linkId !== grant.linkId ||
        fresh.installationId !== grant.installationId ||
        fresh.workspaceId !== grant.workspaceId
      )
        return null
      await resolveScope(grant.ownerId, grant.workspaceId)
      return { auth: authFor(grant) }
    },
  })
  return {
    ...native,
    routes: native.routes.map((route) =>
      route.transport === 'websocket'
        ? route
        : {
            ...route,
            async handler(request, args) {
              const channelEnv = env()
              const signingSecret = channelEnv.SLACK_SIGNING_SECRET
              if (!signingSecret) return new Response('Slack is not configured', { status: 503 })
              const raw = await request.clone().text()
              if (
                !validSlackSignature(
                  raw,
                  request.headers.get('x-slack-request-timestamp'),
                  request.headers.get('x-slack-signature'),
                  signingSecret,
                )
              )
                return new Response('Invalid signature', { status: 401 })
              let payload: unknown
              try {
                payload = request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')
                  ? JSON.parse(new URLSearchParams(raw).get('payload') ?? 'null')
                  : JSON.parse(raw)
              } catch {
                return new Response('Invalid JSON', { status: 400 })
              }
              if (
                payload &&
                typeof payload === 'object' &&
                'type' in payload &&
                payload.type === 'url_verification' &&
                'challenge' in payload &&
                typeof payload.challenge === 'string'
              )
                return Response.json({ challenge: payload.challenge })
              const app = channelEnv.SLACK_APP_ID
              if (!app) return new Response(null, { status: 503 })
              const removal = signedRevocation(app, payload)
              if (removal) {
                if (removal.member) await memberRemoved(app, removal.team, removal.member, removal.eventAt)
                else for (const bot of removal.bots ?? [null]) await revoked(app, removal.team, bot, removal.eventAt)
                return new Response(null, { status: 204 })
              }
              const identity = signedCoordinates(app, payload)
              if (!identity) return new Response(null, { status: 204 })
              const installed = await binding(app, identity.team, identity.sender)
              if (
                !installed ||
                installed.teamId !== identity.team ||
                installed.slackUserId !== identity.sender ||
                installed.botUserId === identity.sender ||
                identity.botUsers.some((id) => id !== installed.botUserId)
              )
                return new Response(null, { status: 204 })
              let scope: SlackScope
              try {
                scope = await resolveScope(installed.ownerId, installed.workspaceId)
              } catch (error) {
                if (error instanceof Error && ['workspaceAccessDenied', 'botNotFound'].includes(error.message))
                  return new Response(null, { status: 204 })
                throw error
              }
              if (scope.workspaceId !== installed.workspaceId || scope.ownerId !== installed.ownerId)
                return new Response(null, { status: 204 })
              const grant: SlackGrantScope = {
                ...scope,
                surface: 'slack',
                installationId: installed.installationId,
                linkId: installed.linkId,
                teamId: installed.teamId,
                slackUserId: installed.slackUserId,
              }
              const addressFor = (address: string) =>
                JSON.stringify([scope.ownerId, scope.workspaceId, grant.linkId, address])
              const scoped: RouteHandlerArgs<SlackChannelState> = {
                ...args,
                from(address) {
                  const source = args.from(addressFor(address))
                  return {
                    ...source,
                    send: (message, options) =>
                      source.send(message, {
                        ...options,
                        ...(identity.eventId ? { idempotencyKey: `slack:${identity.team}:${identity.eventId}` } : {}),
                      }),
                  }
                },
                resolveSession: (address) => args.resolveSession(addressFor(address)),
              }
              return slackRequest.run(grant, () => route.handler(request, scoped))
            },
          },
    ),
  }
}
