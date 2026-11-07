import { CloudServiceError, cloudErrorStatus } from './errors'
import { selfHostedAddress } from './config'
import { AVAILABLE_CLOUD_SCOPES, type CloudScope } from './types'
import type { CloudClientStore } from './store'

export const CLOUD_HEADERS = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
type Session = { user: { id: string }; session: { id: string } } | null
type Dependencies = { client: CloudClientStore; session: (headers: Headers) => Promise<Session>; administrator: (userId: string) => boolean; community: () => boolean; env?: Record<string, string | undefined>; changed: (userId: string) => Promise<unknown> }

/** OAuth state is tied to the exact fresh local session; cloud identity never
 * chooses which local person receives the binding. */
export function cloudHandlers(deps: Dependencies) {
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: CLOUD_HEADERS })
  const handle = (work: (request: Request, session: NonNullable<Session>) => Promise<Response>) => async (request: Request) => {
    try {
      if (!deps.community()) return reply({ error: 'cloud_access_denied' }, 403)
      const session = await deps.session(request.headers)
      if (!session) return reply({ error: 'authRequired' }, 401)
      return await work(request, session)
    } catch (error) {
      if (error instanceof CloudServiceError) return reply({ error: error.code }, cloudErrorStatus(error.code))
      throw error
    }
  }
  const requireWrite = (request: Request) => {
    if (request.headers.get('origin') !== selfHostedAddress(deps.env).origin || request.headers.get('sec-fetch-site') === 'cross-site'
      || request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new CloudServiceError('cloud_access_denied', 'origin')
  }
  const input = async (request: Request) => {
    // All operations have tiny fixed fields. Never accept a multi-megabyte key.
    const text = await request.text()
    if (text.length > 4096) throw new CloudServiceError('cloud_invalid_request', 'protocol')
    try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CloudServiceError('cloud_invalid_request', 'protocol'); return value as Record<string, unknown> }
    catch (error) { if (error instanceof CloudServiceError) throw error; throw new CloudServiceError('cloud_invalid_request', 'protocol', error) }
  }
  return {
    status: handle(async (_request, session) => reply(await deps.client.view(session.user.id, deps.administrator(session.user.id)))),
    connect: handle(async (request, session) => {
      requireWrite(request)
      const body = await input(request)
      if (body.action === 'bind') {
        const scopes = Array.isArray(body.scopes) && body.scopes.every(scope => (AVAILABLE_CLOUD_SCOPES as readonly CloudScope[]).includes(scope as CloudScope)) ? body.scopes as CloudScope[] : null
        if (!scopes) throw new CloudServiceError('cloud_invalid_request', 'protocol')
        return reply(await deps.client.beginBinding(session.user.id, session.session.id, scopes))
      }
      if (!deps.administrator(session.user.id)) throw new CloudServiceError('cloud_access_denied', 'administrator')
      if (body.action === 'register' && typeof body.name === 'string') { await deps.client.register(body.name) }
      else if (body.action === 'key' && typeof body.key === 'string') { await deps.client.connectTeamKey(body.key) }
      else if (body.action === 'push-content' && (body.value === 'full' || body.value === 'reminder')) { await deps.client.setPushContent(body.value) }
      else throw new CloudServiceError('cloud_invalid_request', 'protocol')
      await deps.changed(session.user.id)
      return reply(await deps.client.view(session.user.id, true))
    }),
    disconnect: handle(async (request, session) => {
      requireWrite(request)
      const body = await input(request)
      if (body.action === 'personal') await deps.client.disconnect(session.user.id)
      else {
        if (!deps.administrator(session.user.id)) throw new CloudServiceError('cloud_access_denied', 'administrator')
        if (body.action === 'key') await deps.client.disconnect(session.user.id, true)
        else if (body.action === 'server') await deps.client.disconnectServer()
        else throw new CloudServiceError('cloud_invalid_request', 'protocol')
      }
      await deps.changed(session.user.id)
      return reply(await deps.client.view(session.user.id, deps.administrator(session.user.id)))
    }),
    callback: handle(async (request, session) => {
      const url = new URL(request.url), address = selfHostedAddress(deps.env)
      // Cloud denial is an explicit failed binding, never successful navigation.
      if (url.searchParams.has('error')) throw new CloudServiceError('cloud_access_denied')
      await deps.client.completeBinding(session.user.id, session.session.id, url.searchParams.get('state') ?? '', url.searchParams.get('code') ?? '')
      await deps.changed(session.user.id)
      return new Response(null, { status: 303, headers: { ...CLOUD_HEADERS, Location: `${address.origin}${address.basePath}/settings?section=account` } })
    }),
  }
}
