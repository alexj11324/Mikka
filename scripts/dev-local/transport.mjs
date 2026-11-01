import { MVP_SERVICES } from '../../tests/mvp/isolated-env.mjs'
import { MVP_DECISION_KEY } from '../../tests/mvp/transport.mjs'
import { assertDevLocal } from './guard.mjs'

/**
 * Where a server request goes in dev:local. GitHub's API always goes to the
 * local fake (tests/mvp/services.mjs); the Decisions endpoint only when no real
 * gateway key is set. Everything else, the model included, is left alone.
 */
export function devLocalTarget(href, env) {
  const url = new URL(href)
  if (url.origin === 'https://api.github.com') return `${MVP_SERVICES}/github${url.pathname}${url.search}`
  if (url.href === 'https://ai-gateway.vercel.sh/v1/decisions' && env.AI_GATEWAY_API_KEY === MVP_DECISION_KEY) return `${MVP_SERVICES}/decisions`
  return null
}

/** Installed only by scripts/dev-local/preload.mjs, after the dev:local guard. */
export function installDevLocalTransport(env = process.env, upstreamFetch = globalThis.fetch) {
  assertDevLocal(env)
  const previous = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init)
    const target = devLocalTarget(request.url, env)
    return target ? upstreamFetch(new Request(target, request), { redirect: 'error' }) : upstreamFetch(request)
  }
  return () => { globalThis.fetch = previous }
}
