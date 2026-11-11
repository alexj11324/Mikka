import { Client } from 'eve/client'
import { internalEveAuthorization } from './auth'
import { assertEveScope, type EveScope } from './scope'

export function eveInternalOrigin() {
  return process.env.MIKKA_EVE_ORIGIN ?? 'http://127.0.0.1:3002'
}
/** One authenticated upstream protocol for web, native clients and host events. */
export function eveClient(scope: EveScope) {
  const base = new URL(eveInternalOrigin())
  base.searchParams.set('botId', scope.botId)
  return new Client({ baseUrl: base.toString(), headers: () => ({ authorization: internalEveAuthorization(scope) }) })
}

export async function sendEveEvent(scope: EveScope, eventId: string) {
  await assertEveScope(scope)
  const response = await fetch(new URL('/eve/v1/mikka/events', eveInternalOrigin()), {
    method: 'POST', headers: { authorization: internalEveAuthorization(scope), 'content-type': 'application/json' },
    body: JSON.stringify({ eventId }),
  })
  if (!response.ok) throw new Error('coordinatorUnavailable')
  return await response.json() as { sessionId: string; deliveryId: string }
}
