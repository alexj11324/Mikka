import { MVP_SERVICES } from '../../tests/mvp/isolated-env.mjs'
import { MVP_DECISION_KEY } from '../../tests/mvp/transport.mjs'
import { assertDevLocal } from './guard.mjs'
import { LOCAL_RESEND_KEY } from './services.mjs'

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
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init)
    const target = devLocalTarget(request.url, env)
    return target ? upstreamFetch(new Request(target, request), { redirect: 'error' }) : upstreamFetch(request)
  }
  return () => { globalThis.fetch = previous }
}
