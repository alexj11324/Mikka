import 'server-only'
import { Client } from 'eve/client'
import { internalEveAuthorization } from './auth'
import { assertEveScope, type EveScope } from './scope'

export function eveInternalOrigin() {
  return process.env.MIKKA_EVE_ORIGIN ?? new URL('/mikka/api/agents', process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:3000').toString()
}
/** One authenticated upstream protocol for web, native clients and host events. */
export function eveClient(scope: EveScope) {
  const base = new URL(eveInternalOrigin())
  base.searchParams.set('botId', scope.botId)
  return new Client({ baseUrl: base.toString(), headers: () => ({ authorization: internalEveAuthorization(scope) }) })
}

export async function sendEveEvent(scope: EveScope, eventId: string) {
  await assertEveScope(scope)
  const target = new URL(eveInternalOrigin())
  target.pathname = target.pathname.replace(/\/$/, '') + '/eve/v1/mikka/events'
  const response = await fetch(target, {
    method: 'POST', headers: { authorization: internalEveAuthorization(scope), 'content-type': 'application/json' },
    body: JSON.stringify({ eventId }),
  })
  if (!response.ok) throw new Error('coordinatorUnavailable')
  return await response.json() as { sessionId: string; deliveryId: string }
}
