import type { createApprovedWrites } from './approved-writes'
import { WRITE_ACTIONS, type WriteActionName } from './write-contract'
import { OperationError } from './ledger'
/** Route factory only; product owner chooses URL/registration. No worker tokens.
 * Bind auth to the real Better Auth instance; never construct actor from JSON. */
export function approvedWriteHandler(auth: { api: { getSession: (args: { headers: Headers; query: { disableCookieCache: boolean } }) => Promise<{ user: { id: string }; session: { id: string } } | null> } }, operations: (action: WriteActionName) => ReturnType<typeof createApprovedWrites>) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    if (request.headers.has('authorization') || !request.headers.get('cookie')) return new Response(null, { status: 401 })
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response(null, { status: 403 })
    const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
    if (!session) return new Response(null, { status: 401 })
    try {
      const body = await request.json()
      if (!WRITE_ACTIONS.includes(body.action)) return new Response(null, { status: 400 })
      const service = operations(body.action)
      const result = body.op === 'propose'
        ? await service.propose(session.user.id, body.input, body.intentId)
        : body.op === 'decide' && typeof body.approve === 'boolean'
          ? await service.decide({ userId: session.user.id, sessionId: session.session.id }, body.id, body.approve)
          : null
      return result ? Response.json(result, { headers: { 'cache-control': 'no-store' } }) : new Response(null, { status: 400 })
    } catch (error) {
      return Response.json({ error: error instanceof OperationError ? error.message : 'invalidWriteRequest' }, { status: 409 })
    }
  }
}
