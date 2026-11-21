import { createHmac } from 'node:crypto'

export const maxRemainingMs = 60_000
// Leave room for clock skew between the issuer and the receiving Eve host.
const issuedLifetimeMs = maxRemainingMs - 1_000

/**
 * @param {import('./scope').EveScope} scope
 * @param {string | undefined} secret
 * @param {number} [now]
 */
export function signInternalEveAuthorization(scope, secret, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('authRequired')
  const payload = Buffer.from(JSON.stringify({ ...scope, expires: now + issuedLifetimeMs })).toString('base64url')
  const signature = createHmac('sha256', secret).update('mikka:eve:v1:' + payload).digest('base64url')
  return `Bearer mev_${payload}.${signature}`
}
