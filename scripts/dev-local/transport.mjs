import { MVP_SERVICES } from '../../tests/mvp/isolated-env.mjs'
import { MVP_DECISION_KEY } from '../../tests/mvp/transport.mjs'
import { assertDevLocal } from './guard.mjs'
import { LOCAL_RESEND_KEY } from './services.mjs'

const marker = Symbol.for('mikka.dev-local.loopback-fetch.v1')
const probeURL = `${MVP_SERVICES}/.mikka-dev-local-transport`
const challengeHeader = 'x-mikka-fixture-challenge'
const responseHeader = 'x-mikka-fixture-response'

function binding(env) {
  try {
    assertDevLocal(env)
    const value = globalThis[marker]
    return value && Object.isFrozen(value) && value.version === 1 && value.endpoint === MVP_SERVICES
      && value.gatewayKey === env.AI_GATEWAY_API_KEY && value.mailKey === env.RESEND_API_KEY
      && typeof value.verify === 'function' && typeof value.isCurrent === 'function' ? value : null
  } catch { return null }
}

export async function verifyDevLocalTransport(env = process.env) {
  return binding(env)?.verify() ?? false
}

export function hasBoundDevLocalTransport(env = process.env) {
  return binding(env)?.isCurrent() === true
}

/**
 * Where a server request goes in dev:local. GitHub's API always goes to the
 * local fake (tests/mvp/services.mjs). The AI Gateway (model and Decisions) and
 * Resend go to their local substitutes (scripts/dev-local/services.mjs) only
 * when scripts/dev-local.mjs set the placeholder because no real key was set.
 * Everything else, a workspace's own model key included, is left alone.
 */
export function devLocalTarget(href, env) {
  const url = new URL(href)
  if (url.origin === 'https://api.github.com') return `${MVP_SERVICES}/github${url.pathname}${url.search}`
  if (url.origin === 'https://ai-gateway.vercel.sh' && env.AI_GATEWAY_API_KEY === MVP_DECISION_KEY) return `${MVP_SERVICES}/gateway${url.pathname}${url.search}`
  if (url.href === 'https://api.resend.com/emails' && env.RESEND_API_KEY === LOCAL_RESEND_KEY) return `${MVP_SERVICES}/resend/emails`
  return null
}

/** Installed only by scripts/dev-local/preload.mjs, after the dev:local guard. */
export function installDevLocalTransport(env = process.env, upstreamFetch = globalThis.fetch) {
  assertDevLocal(env)
  const previous = globalThis.fetch
  const previousMarker = Object.getOwnPropertyDescriptor(globalThis, marker)
  const challenges = new Map()
  let verifiedFetch = null
  const transport = (input, init) => {
    const request = new Request(input, init)
    if (request.url === probeURL) {
      const nonce = request.headers.get(challengeHeader)
      const response = challenges.get(nonce)
      challenges.delete(nonce)
      if (!response) throw new Error('Local transport challenge unavailable')
      return Promise.resolve(new Response(null, { status: 204, headers: { [responseHeader]: response } }))
    }
    const target = devLocalTarget(request.url, env)
    return target ? upstreamFetch(new Request(target, request), { redirect: 'error' }) : upstreamFetch(request)
  }
  const installed = Object.freeze({
    version: 1, endpoint: MVP_SERVICES, gatewayKey: env.AI_GATEWAY_API_KEY, mailKey: env.RESEND_API_KEY,
    isCurrent: () => verifiedFetch !== null && verifiedFetch === globalThis.fetch,
    async verify() {
      const current = globalThis.fetch
      const nonce = randomUUID(), secret = randomUUID()
      verifiedFetch = null
      challenges.set(nonce, secret)
      try {
        const response = await current(probeURL, { headers: { [challengeHeader]: nonce }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(1000) })
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
    verifiedFetch = null; challenges.clear()
    globalThis.fetch = previous
    if (previousMarker) Object.defineProperty(globalThis, marker, previousMarker)
    else delete globalThis[marker]
  }
}
import { randomUUID } from 'node:crypto'
