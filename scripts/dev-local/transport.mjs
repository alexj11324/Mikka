import { MVP_SERVICES } from '../../tests/mvp/isolated-env.mjs'
import { assertDevLocal } from './guard.mjs'
import { LOCAL_RESEND_KEY, LOCAL_LITELLM_KEY, LOCAL_LITELLM_URL } from './services.mjs'
import { assertTestModelRequest } from '../test-model-policy.mjs'
import { FAKE_MODEL_KEY } from '../../tests/fakes/litellm.mjs'

const marker = Symbol.for('mikka.dev-local.loopback-fetch.v1')
const probeURL = `${MVP_SERVICES}/.mikka-dev-local-transport`
const challengeHeader = 'x-mikka-fixture-challenge'
const responseHeader = 'x-mikka-fixture-response'

function binding(env) {
  try {
    assertDevLocal(env)
    const value = globalThis[marker]
    return value && Object.isFrozen(value) && value.version === 1 && value.endpoint === MVP_SERVICES
      && value.gatewayKey === env.MIKKA_LITELLM_MASTER_KEY && value.modelUrl === env.MIKKA_LITELLM_URL && value.mailKey === env.RESEND_API_KEY
      && typeof value.verify === 'function' && typeof value.isCurrent === 'function' ? value : null
  } catch { return null }
}

export async function verifyDevLocalTransport(env = process.env) {
  return binding(env)?.verify() ?? false
}

export function hasBoundDevLocalTransport(env = process.env) {
  return binding(env)?.isCurrent() === true
}

/** HTTP substitutes are bounded to their existing provider routes. */
export function devLocalTarget(href, env) {
  const url = new URL(href)
  if (url.origin === 'https://api.github.com') return `${MVP_SERVICES}/github${url.pathname}${url.search}`
  if (env.MIKKA_LITELLM_URL === LOCAL_LITELLM_URL && env.MIKKA_LITELLM_MASTER_KEY === LOCAL_LITELLM_KEY
    && url.href.startsWith(LOCAL_LITELLM_URL + '/v1/')) return url.href
  if (env.MIKKA_LOCAL_LIVE_MODELS !== '1' && url.origin === 'https://api.deepseek.com' && ['/models', '/v1/models'].includes(url.pathname) && !url.search)
    return `${LOCAL_LITELLM_URL}/v1/models`
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
  const transport = async (input, init) => {
    const request = new Request(input, init)
    if (request.url === probeURL) {
      const nonce = request.headers.get(challengeHeader)
      const response = challenges.get(nonce)
      challenges.delete(nonce)
      if (!response) throw new Error('Local transport challenge unavailable')
      return Promise.resolve(new Response(null, { status: 204, headers: { [responseHeader]: response } }))
    }
    const target = devLocalTarget(request.url, env)
    if (!target) await assertTestModelRequest(request)
    if (target) {
      const forwarded = new Request(target, request)
      if (new URL(request.url).origin === 'https://api.deepseek.com') {
        if (request.method !== 'GET' || request.headers.get('authorization') !== `Bearer ${FAKE_MODEL_KEY}`) throw new Error('Synthetic model metadata requires the public placeholder key')
        forwarded.headers.set('authorization', `Bearer ${LOCAL_LITELLM_KEY}`)
      }
      return upstreamFetch(forwarded, { redirect: 'error' })
    }
    const url = new URL(request.url)
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:') return upstreamFetch(request, { redirect: 'error' })
    const liveBase = env.MIKKA_LOCAL_LIVE_MODELS === '1' && env.MIKKA_LITELLM_URL?.replace(/\/+$/, '')
    if (liveBase && request.url.startsWith(`${liveBase}/v1/`)) return upstreamFetch(request, { redirect: 'error' })
    throw new Error('Local scripted transport refused an unstubbed external request')
  }
  const installed = Object.freeze({
    version: 1, endpoint: MVP_SERVICES, gatewayKey: env.MIKKA_LITELLM_MASTER_KEY, modelUrl: env.MIKKA_LITELLM_URL, mailKey: env.RESEND_API_KEY,
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
