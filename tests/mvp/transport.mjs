import { randomUUID } from 'node:crypto'
import { assertMvpEnvironment, MVP_SERVICES } from './isolated-env.mjs'

export const MVP_DECISION_KEY = 'mvp-synthetic-decisions'
const marker = Symbol.for('mikka.mvp.loopback-fetch.v1')
const probeURL = `${MVP_SERVICES}/.mikka-loopback-transport`
const challengeHeader = 'x-mikka-fixture-challenge'
const responseHeader = 'x-mikka-fixture-response'

function binding(env) {
  try {
    assertMvpEnvironment(env)
    if (env.AI_GATEWAY_API_KEY !== MVP_DECISION_KEY) return null
    const value = globalThis[marker]
    return value && Object.isFrozen(value) && value.version === 1 && value.endpoint === MVP_SERVICES
      && typeof value.verify === 'function' && typeof value.isCurrent === 'function' ? value : null
  } catch { return null }
}

/** Installed only by the isolated MVP preload. No application provider uses it. */
export function installMvpTransport(env = process.env, upstreamFetch = globalThis.fetch) {
  assertMvpEnvironment(env)
  if (env.AI_GATEWAY_API_KEY !== MVP_DECISION_KEY) throw new Error('MVP transport requires its public synthetic marker')
  const previousFetch = globalThis.fetch
  const previousMarker = Object.getOwnPropertyDescriptor(globalThis, marker)
  const challenges = new Map()
  let verifiedFetch = null
  const transport = (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.href === probeURL) {
      const nonce = request.headers.get(challengeHeader)
      const response = challenges.get(nonce)
      challenges.delete(nonce)
      if (!response) throw new Error('MVP transport challenge unavailable')
      return Promise.resolve(new Response(null, { status: 204, headers: { [responseHeader]: response } }))
    }
    if (url.origin === 'https://api.github.com')
      return upstreamFetch(new Request(`${MVP_SERVICES}/github${url.pathname}${url.search}`, request), { redirect: 'error' })
    if (url.href === 'https://ai-gateway.vercel.sh/v1/decisions')
      return upstreamFetch(new Request(`${MVP_SERVICES}/decisions`, request), { redirect: 'error' })
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('MVP fixture refused an unstubbed external request')
    return upstreamFetch(request, { redirect: 'error' })
  }
  const installed = Object.freeze({
    version: 1,
    endpoint: MVP_SERVICES,
    isCurrent: () => verifiedFetch !== null && verifiedFetch === globalThis.fetch,
    async verify() {
      const current = globalThis.fetch
      const nonce = randomUUID(), secret = randomUUID()
      verifiedFetch = null
      challenges.set(nonce, secret)
      try {
        // Next wraps fetch through an opaque dedupe closure. Prove the active
        // path reaches this transport without sending a request to any server.
        const response = await current(probeURL, {
          headers: { [challengeHeader]: nonce }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(1000),
        })
        const valid = response.status === 204 && response.headers.get(responseHeader) === secret && globalThis.fetch === current
        await response.body?.cancel()
        if (valid) verifiedFetch = current
        return valid
      } catch { return false }
      finally { challenges.delete(nonce) }
    },
  })
  globalThis.fetch = transport
  Object.defineProperty(globalThis, marker, { value: installed, configurable: true, writable: false })
  return () => {
    if (globalThis[marker] !== installed) return
    verifiedFetch = null
    challenges.clear()
    globalThis.fetch = previousFetch
    if (previousMarker) Object.defineProperty(globalThis, marker, previousMarker)
    else delete globalThis[marker]
  }
}

export async function verifyMvpTransport(env = process.env) {
  const installed = binding(env)
  return installed ? installed.verify() : false
}

/** A changed fetch implementation invalidates the last successful proof. */
export function hasBoundMvpTransport(env = process.env) {
  return binding(env)?.isCurrent() === true
}
