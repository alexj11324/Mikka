/** Platform deployment data only. Customer connections remain in Mikka's stores. */
export const EVE_PUBLIC_PREFIX = '/mikka/api/agents'
export function hostConfiguration(env) {
  const publicOrigin = env.EVE_PUBLIC_ORIGIN
  const runtime = Object.fromEntries(Object.entries(env)
    .filter(([key]) => key.startsWith('EVE_ENV_'))
    .map(([key, value]) => [key.slice('EVE_ENV_'.length), value]))
  return {
    releaseId: env.EVE_RELEASE_ID, sourceSha: env.EVE_SOURCE_SHA, uiSha: env.EVE_UI_SHA,
    publicOrigin,
    runtimeEnv: {
      ...runtime, NODE_ENV: 'production', MIKKA_EVE_HOST: 'cloudflare', MIKKA_HOSTED_MODEL_FALLBACK: 'cloudflare-workers-ai',
      WORKFLOW_TARGET_WORLD: '@workflow/world-postgres',
      MIKKA_DEPLOYMENT_ID: env.EVE_RELEASE_ID, WORKFLOW_DEPLOYMENT_ID: env.EVE_RELEASE_ID, MIKKA_EVE_PUBLIC_ORIGIN: publicOrigin,
      MIKKA_BUILD_REVISION: env.EVE_SOURCE_SHA, MIKKA_UI_OVERLAY_SHA: env.EVE_UI_SHA,
      MIKKA_EVE_RELEASE_ID: env.EVE_RELEASE_ID,
    },
  }
}

/** Keep the existing namespaced native protocol; do not capture business API routes. */
export function nativeRequest(request) {
  const url = new URL(request.url)
  let path
  if (url.pathname === '/mikka/api/webhooks/slack' || url.pathname === '/mikka/api/webhooks/slack/') {
    path = '/eve/v1/slack'
  } else if (url.pathname.startsWith(EVE_PUBLIC_PREFIX + '/')) {
    path = url.pathname.slice(EVE_PUBLIC_PREFIX.length)
  } else return null
  if (!path.startsWith('/eve/v1/')
    || /[\\?#]/.test(path) || /%2f|%5c|%2e|\/\.\.?\//i.test(path)) return null
  const headers = new Headers(request.headers)
  headers.set('x-forwarded-host', url.host)
  headers.set('x-forwarded-proto', url.protocol.slice(0, -1))
  url.pathname = path
  return new Request(url, {
    method: request.method, headers, signal: request.signal,
    ...(!['GET', 'HEAD'].includes(request.method) && request.body ? { body: request.body, duplex: 'half' } : {}),
  })
}
