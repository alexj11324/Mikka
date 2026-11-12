/** Platform deployment data only. Customer connections remain in Mikka's stores. */
export const EVE_HOST_PORT = 8080
export const EVE_PUBLIC_PREFIX = '/mikka/api/agents'
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const release = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value) && !value.startsWith('dpl_')
const invalid = () => { throw new Error('CF_EVE_HOST_CONFIGURATION_INVALID') }

function httpsOrigin(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return invalid()
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return invalid()
  return url.origin
}

export function hostConfiguration(env) {
  if (!sha(env.EVE_SOURCE_SHA) || !sha(env.EVE_UI_SHA) || !release(env.EVE_RELEASE_ID)
    || !['on-demand', 'shared-warm'].includes(env.EVE_HOST_POLICY)) return invalid()
  const warm = env.EVE_HOST_POLICY === 'shared-warm'
  const warmUntil = warm ? Date.parse(env.EVE_HOST_WARM_UNTIL ?? '') : Infinity
  // A trusted candidate lease bounds standby cost independently of HTTP traffic.
  // Expired configuration remains readable so restoration can stop the host.
  if (warm && (!Number.isFinite(warmUntil) || warmUntil <= 0 || warmUntil > Date.now() + 24 * 60 * 60_000)) return invalid()
  if (!warm && env.EVE_HOST_WARM_UNTIL !== undefined) return invalid()
  const publicOrigin = httpsOrigin(env.EVE_PUBLIC_ORIGIN)
  const runtime = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('EVE_ENV_')) continue
    const name = key.slice('EVE_ENV_'.length)
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== 'string') return invalid()
    // These values select hosting and durable storage, rather than credentials.
    if (name === 'MIKKA_HOSTED_MODEL_FALLBACK' && value !== 'cloudflare-workers-ai') return invalid()
    if (['VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_DEPLOYMENT_ID', 'VERCEL_OIDC_TOKEN', 'AI_GATEWAY_API_KEY',
      'EVE_QUEUE_SIGNING_KEY', 'WORLD_QUEUE_ED25519_PRIVATE_KEY', 'WORKFLOW_POSTGRES_URL', 'MIKKA_EVE_WORLD_TOKEN', 'MIKKA_EVE_PRODUCT_TOKEN', 'MIKKA_WORKERS_AI_CAPABILITY',
      'WORKFLOW_DEPLOYMENT_ID', 'MIKKA_DEPLOYMENT_ID', 'NODE_EXTRA_CA_CERTS', 'MIKKA_EVE_ORIGIN', 'WORKFLOW_TARGET_WORLD', 'WORKFLOW_LOCAL_DATA_DIR',
      'WORKFLOW_LOCAL_BASE_URL', 'MIKKA_EVE_WORKFLOW_WORLD', 'MIKKA_EVE_HOST',
      'SLACK_USER_BINDINGS', 'SLACK_WATCHED_CHANNELS', 'SLACK_CHANNEL_WORKSPACES',
      'SLACK_TEAM_ID', 'SLACK_BOT_USER_ID', 'SLACK_BOT_TOKEN'].includes(name)) return invalid()
    runtime[name] = value
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(env.WORLD_QUEUE_PUBLIC_KEY ?? '') || !env.WORLD_SERVICE?.fetch
    || typeof runtime.BETTER_AUTH_SECRET !== 'string' || runtime.BETTER_AUTH_SECRET.length < 32
    || !(runtime.MIKKA_DATABASE_URL || runtime.DATABASE_URL)
    || !['production', 'preview'].includes(runtime.MIKKA_DEPLOYMENT_STAGE)) return invalid()
  httpsOrigin(runtime.BETTER_AUTH_URL)
  return {
    releaseId: env.EVE_RELEASE_ID, sourceSha: env.EVE_SOURCE_SHA, uiSha: env.EVE_UI_SHA,
    publicOrigin, policy: env.EVE_HOST_POLICY, warmUntil,
    runtimeEnv: {
      ...runtime, NODE_ENV: 'production', MIKKA_EVE_HOST: 'cloudflare', MIKKA_HOSTED_MODEL_FALLBACK: 'cloudflare-workers-ai',
      MIKKA_EVE_WORKFLOW_WORLD: 'cloudflare', MIKKA_WORKFLOW_QUEUE_PUBLIC_KEY: env.WORLD_QUEUE_PUBLIC_KEY,
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

export function validateHostBuild(build, host, env) {
  if (!build || build.version !== 1 || build.eve !== '1.0.0-rc.9'
    || build.preset !== 'node-server' || build.world !== '@mikka/eve-cloudflare-world'
    || build.worldVersion !== '5.1.0' || !sha(build.revision)
    || !host || host.version !== 1 || !release(host.releaseId)
    || host.sourceSha !== build.revision || !sha(host.uiSha)
    || (host.uiSource === 'public-server' && (host.uiSha !== host.sourceSha || env.MIKKA_DEPLOYMENT_STAGE === 'production'))
    || env.MIKKA_EVE_HOST !== 'cloudflare' || env.MIKKA_EVE_WORKFLOW_WORLD !== 'cloudflare'
    || env.MIKKA_BUILD_REVISION !== host.sourceSha || env.MIKKA_UI_OVERLAY_SHA !== host.uiSha
    || env.MIKKA_EVE_RELEASE_ID !== host.releaseId) return invalid()
  return host
}
