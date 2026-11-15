import { eveChannel, type EveAuthResult } from 'eve/channels/eve'
import { POST, type RouteHandlerArgs, type HttpRouteDefinition } from 'eve/channels'
import { z } from 'zod'
import { ActionFailureError } from '../action-error'
import { authenticateEveRequest, internalEveRequestScope } from './auth'
import { assertSessionScope, conversationAddress, registerSession, scopeFromAuth, scopeAuth, type EveScope } from './scope'
import { priorHistory } from './history'
import { withSessionControlDelivery } from './session-control-delivery.mjs'
import { forwardEveRequest } from './forward-request'

const body = z.object({ message: z.unknown().optional(), operationId: z.string().optional(), clientContext: z.unknown().optional() }).passthrough()

async function sessionFor(args: RouteHandlerArgs, scope: EveScope) {
  const result = await args.from(conversationAddress(scope)).create({ auth: scopeAuth(scope), history: await priorHistory(scope) })
  return result.session
}

const accessRefusals = new WeakSet<Request>()
// The native channel consumes the request body before its onMessage hook.
// Bind the selected admission policy to the forwarded, authenticated request.
const steeringRequests = new WeakSet<Request>()

/** Keep eve's protocol, changing only ownership, prior history and product ingress. */
export function mikkaEveChannel() {
  const verifiedRequests = new WeakMap<Request, EveAuthResult>()
  async function admit(request: Request, auth: EveAuthResult, deliver: () => Response | Promise<Response>) {
    const refused = () => Response.json({ ok: false, code: 'accessChangeConfirmationRequired', error: 'accessChangeConfirmationRequired' }, { status: 409 })
    // The native route receives the exact rewritten request verified by this wrapper.
    verifiedRequests.set(request, auth)
    try {
      const response = await deliver()
      return accessRefusals.has(request) ? refused() : response
    } catch (error) {
      if (accessRefusals.has(request)) return refused()
      throw error
    } finally {
      verifiedRequests.delete(request)
    }
  }
  const base = eveChannel({ auth: request => verifiedRequests.get(request) ?? authenticateEveRequest(request), turnPolicy: 'queue', audience: 'private',
    async onMessage(ctx, message) {
      const scope = scopeFromAuth(ctx.eve.caller)
      const { acceptEveMessage } = await import('./submission')
      const accepted = await acceptEveMessage(scope, message, ctx.eve.clientContext, ctx.eve.request, steeringRequests.has(ctx.eve.request) ? 'steer' : undefined).catch(error => {
        if (error instanceof ActionFailureError && error.code === 'accessChangeConfirmationRequired' && error.confirmable) accessRefusals.add(ctx.eve.request)
        throw error
      })
      return { auth: { ...scopeAuth(scope), attributes: { ...scopeAuth(scope).attributes, sourceEventId: accepted.eventId } }, context: accepted.context, clientContext: [] }
    },
  })
  const follow = base.routes.find(route => route.transport !== 'websocket' && route.method === 'POST' && route.path === '/eve/v1/session/:sessionId') as HttpRouteDefinition | undefined
  if (!follow) throw new Error('eveProtocolUnavailable')
  return { ...base, routes: [
    ...base.routes.map(route => route.transport === 'websocket' || !route.path.startsWith('/eve/v1/session') ? route : {
      ...route,
      async handler(request: Request, args: RouteHandlerArgs) {
        const auth = await authenticateEveRequest(request)
        if (!auth) return Response.json({ ok:false,error:'authRequired' }, { status:401 })
        const scope = scopeFromAuth(auth)
        if (route.method === 'POST' && route.path === '/eve/v1/session') {
          const input = body.parse(await request.clone().json().catch(() => ({})))
          const session = await sessionFor(args,scope)
          await registerSession(scope,session.id)
          if (input.message === undefined) return Response.json({ ok:true, sessionId:session.id })
          const { operationId: _operation, ...payload } = input
          const submission = request.headers.get('x-mikka-submission-id')
          if (submission) payload.idempotencyKey = z.uuid().parse(submission)
          const url = new URL(request.url); url.pathname = `/eve/v1/session/${session.id}`
          const forwarded = forwardEveRequest(request,url,JSON.stringify(payload))
          if (payload.turnPolicy === 'steer') steeringRequests.add(forwarded)
          const response = await admit(forwarded, auth, () => follow.handler(forwarded, { ...args, params:{sessionId:session.id} }))
          if (response.ok) await (await import('./submission')).commitEveIngress(forwarded)
          return response
        }
        const sessionId = args.params.sessionId ?? args.params.parentSessionId
        if (!sessionId) return Response.json({ ok:false,error:'notFound' }, { status:404 })
        try {
          await assertSessionScope(scope, sessionId)
        } catch (error) {
          if (error instanceof Error && ['notFound', 'botNotFound', 'workspaceAccessDenied'].includes(error.message)) {
            return Response.json({ ok: false, error: 'notFound' }, { status: 404 })
          }
          throw error
        }
        let forwarded = request
        let streamAfter=0
        if (request.method === 'GET' && route.path.endsWith('/stream')) {
          const url=new URL(request.url)
          const parsed=z.coerce.number().int().safeParse(url.searchParams.get('startIndex')??0)
          if (!parsed.success) return Response.json({ok:false,error:'validationGeneric'},{status:400})
          streamAfter=Math.max(0,parsed.data)
          url.searchParams.set('startIndex','0')
          forwarded=forwardEveRequest(request,url)
        }
        if (request.method === 'POST' && route.path === '/eve/v1/session/:sessionId' && request.headers.has('x-mikka-submission-id')) {
          const payload = await request.clone().json()
          payload.idempotencyKey = z.uuid().parse(request.headers.get('x-mikka-submission-id'))
          forwarded = forwardEveRequest(request,request.url,JSON.stringify(payload))
          if (payload.turnPolicy === 'steer') steeringRequests.add(forwarded)
        }
        const response = await admit(forwarded, auth, () => withSessionControlDelivery(route, sessionId, () => route.handler(forwarded,args)))
        if (response.ok) await (await import('./submission')).commitEveIngress(forwarded)
        if (response.ok && response.body && request.method === 'GET' && route.path.endsWith('/stream')) {
          const [{credentialChatFingerprints},{maskEveStream}] = await Promise.all([import('../credentials/chat-guard'),import('./stream-mask')])
          const projection=maskEveStream(scope.ownerId,await credentialChatFingerprints(scope.ownerId),streamAfter)
          return new Response(response.body.pipeThrough(projection),{status:response.status,headers:response.headers})
        }
        return response
      },
    }),
    POST('/eve/v1/mikka/events', async (request,args) => {
      const scope = internalEveRequestScope(request)
      if (!scope) return Response.json({ok:false,error:'authRequired'},{status:401})
      const input = z.object({eventId:z.uuid()}).strict().parse(await request.json())
      const { deliverEveEvent } = await import('./submission')
      const {pool} = await import('../db')
      const event = (await pool.query<{ scheduled: boolean }>(
        `SELECT coalesce(payload->>'source' = 'schedule_due', false) AS scheduled FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND "botId"=$3`,
        [input.eventId, scope.ownerId, scope.botId],
      )).rows[0]
      if (!event) return Response.json({ok:false,error:'notFound'},{status:404})
      const session = event.scheduled
        ? (await args.from(conversationAddress(scope)+':schedule:'+input.eventId).create({auth:scopeAuth(scope)})).session
        : await sessionFor(args,scope)
      await registerSession(scope,session.id)
      const delivery = await deliverEveEvent(scope,session,input.eventId)
      return Response.json({ok:true,sessionId:delivery.sessionId,deliveryId:delivery.deliveryId})
    }),
  ] }
}
