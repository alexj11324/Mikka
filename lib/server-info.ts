import { APP_BUILD } from './app-build'
import { BASE_PATH } from './base-path'
import { authEffectiveTrustedOrigins, authSignInMethods, MOBILE_APP_ORIGIN, resolveAppOrigin } from './auth-config'
import { getEdition } from './edition'
import { isLoopbackHost } from './loopback'
import { mailConfigured } from './mail-delivery'
import { webConnectionEnabled, webConnectionURL } from './web-connection/policy'

type Environment = Record<string, string | undefined>
type Query = (sql: string) => Promise<{ rows: Array<{ hasUsers?: unknown }> }>
type SignIn = ReturnType<typeof authSignInMethods>
export type ServerInfo = {
  kind: 'mikka-server'; schemaVersion: 1; name: string; address: string | null; version: string; edition: 'community'
  status: { configuration: 'ready' | 'unavailable'; database: 'ready' | 'unavailable'; authentication: 'ready' | 'unavailable' }
  communityUI: { enabled: boolean; frozen: true }
  clients: {
    web: { url: string | null; enabled: boolean; requiresHttps: true; serverAddressSupported: boolean }
    desktop: { url: string }
    ios: { url: null; availability: 'link_unavailable'; serverReady: boolean }
  }
  setup: { state: 'required' | 'ready' | 'unavailable'; signUpUrl: string | null; signIn: SignIn; emailDeliveryConfigured: boolean; accountRole: 'personal_workspace_admin' }
}

function configuredOrigin(env: Environment): string | null {
  const value = resolveAppOrigin(env)
  if (!value) return null
  try {
    const url = new URL(value)
    return url.origin === value && !url.username && !url.password && !url.hostname.includes('*')
      && (url.protocol === 'https:' || url.protocol === 'http:' && isLoopbackHost(url.hostname)) ? url.origin : null
  } catch { return null }
}

/** One bounded public-state query. It returns no account identity or count and
 * grants no installation-wide authority to the first person who signs up. */
export async function readServerInfo(options: { env?: Environment; query?: Query; signIn?: () => Promise<SignIn> } = {}): Promise<ServerInfo | null> {
  const env = options.env ?? process.env
  if (getEdition(env) !== 'community') return null
  const origin = configuredOrigin(env), basePath = BASE_PATH || '/mikka'
  const address = origin ? `${origin}${basePath}` : null
  let signIn = authSignInMethods(env), authReady = true, databaseReady = false, hasUsers = false
  if (origin) {
    try {
      const query: Query = options.query ?? (async sql => (await import('./db')).pool.query(sql))
      const result = await query('SELECT EXISTS (SELECT 1 FROM "user") AS "hasUsers"')
      if (typeof result.rows[0]?.hasUsers === 'boolean') { databaseReady = true; hasUsers = result.rows[0].hasUsers }
    } catch { /* Public availability only; driver errors can contain credentials. */ }
    try {
      if (options.signIn) signIn = await options.signIn()
      else if (env.GITHUB_SIGN_IN_USE_APP === 'true') signIn.github = await (await import('./auth')).githubSignInEnabled()
    } catch { authReady = false; signIn = { ...signIn, github: false } }
  }
  let mobileReady = false
  try { mobileReady = authEffectiveTrustedOrigins(env).includes(MOBILE_APP_ORIGIN) } catch { authReady = false }
  const emailDeliveryConfigured = mailConfigured(env)
  const canCreateAccount = authReady && (signIn.google || signIn.github || signIn.email && emailDeliveryConfigured)
  return {
    kind: 'mikka-server', schemaVersion: 1, edition: 'community',
    name: env.MIKKA_SERVER_NAME?.trim().slice(0, 120) || 'Mikka', address,
    version: APP_BUILD || env.MIKKA_BUILD_REVISION || env.VERCEL_GIT_COMMIT_SHA || 'development',
    status: { configuration: origin ? 'ready' : 'unavailable', database: databaseReady ? 'ready' : 'unavailable', authentication: authReady ? 'ready' : 'unavailable' },
    // Retain the v1 discovery field for installed clients.
    communityUI: { enabled: false, frozen: true },
    clients: {
      web: { url: webConnectionURL(env), enabled: webConnectionEnabled(env), requiresHttps: true, serverAddressSupported: Boolean(origin?.startsWith('https://')) },
      desktop: { url: 'https://github.com/alexj11324/Mikka/releases/latest' },
      // No verified App Store/TestFlight link is present in this release's
      // official metadata. Do not invent a download destination.
      ios: { url: null, availability: 'link_unavailable', serverReady: mobileReady },
    },
    setup: { state: !databaseReady ? 'unavailable' : hasUsers ? 'ready' : 'required',
      signUpUrl: databaseReady && !hasUsers && canCreateAccount ? `${address}/sign-up` : null,
      signIn, emailDeliveryConfigured, accountRole: 'personal_workspace_admin' },
  }
}

/** Used by /api/server and the backend's default document entry. HTML layout
 * can consume this stable viewmodel independently of server dispatch. */
export async function serverInfoResponse(request: Request, options: Parameters<typeof readServerInfo>[0] = {}): Promise<Response> {
  const headers = { 'cache-control': 'no-store, max-age=0', 'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' }
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } })
  const info = await readServerInfo(options)
  if (!info) return new Response(null, { status: 404, headers })
  const status = Object.values(info.status).every(value => value === 'ready') ? 200 : 503
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(info), { status, headers })
}
