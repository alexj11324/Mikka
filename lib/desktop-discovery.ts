import { APP_BUILD, desktopBelowMinimum, minDesktopVersion } from './app-build'
import { authEffectiveTrustedOrigins, authSignInMethods, MOBILE_APP_ORIGIN } from './auth-config'
import { BASE_PATH } from './base-path'
import { getEdition } from './edition'
import { DESKTOP_RPC_PREVIOUS_VERSION, DESKTOP_RPC_VERSION, UPDATE_REQUIRED } from './desktop-rpc/wire'

type Environment = Record<string, string | undefined>

/** Public configuration only. Discovering an installation never loads auth,
 * creates a session or returns provider credentials. The route supplies the persisted cloud connection bit. */
export function desktopDiscovery(env: Environment = process.env) {
  const name = env.MIKKA_SERVER_NAME?.trim().slice(0, 120) || 'Mikka'
  return {
    name,
    version: APP_BUILD || env.MIKKA_BUILD_REVISION || env.VERCEL_GIT_COMMIT_SHA || 'development',
    edition: getEdition(env),
    basePath: BASE_PATH || '/mikka',
    desktopProtocol: { min: DESKTOP_RPC_PREVIOUS_VERSION, max: DESKTOP_RPC_VERSION },
    signIn: authSignInMethods(env),
    minDesktopVersion: minDesktopVersion(env.MIN_CLIENT_VERSION),
    cloud: { connected: false },
    mobileReady: authEffectiveTrustedOrigins(env).includes(MOBILE_APP_ORIGIN),
  }
}

export function desktopDiscoveryResponse(request: Request, env: Environment = process.env, signIn?: ReturnType<typeof authSignInMethods>, cloudConnected = false) {
  const discovery = desktopDiscovery(env)
  if (signIn) discovery.signIn = signIn
  discovery.cloud.connected = cloudConnected
  let updateRequired = false
  const version = request.headers.get('x-mikka-client-version')
  if (request.headers.get('x-mikka-client') === 'desktop' && version && discovery.minDesktopVersion) {
    try { updateRequired = desktopBelowMinimum(version, discovery.minDesktopVersion) }
    catch { updateRequired = true }
  }
  return Response.json({ ...discovery, ...(updateRequired ? { error: { code: UPDATE_REQUIRED } } : {}) }, {
    status: updateRequired ? 426 : 200,
    headers: { 'cache-control': 'no-store, max-age=0', 'x-content-type-options': 'nosniff',
      vary: 'x-mikka-client, x-mikka-client-version, x-mikka-desktop-protocol' },
  })
}
