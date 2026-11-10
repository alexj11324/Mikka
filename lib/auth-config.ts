import { createHash } from 'node:crypto'
import { APIError } from 'better-auth/api'
import { localTestAccountsMode } from '@/scripts/test-accounts/database-target.mjs'
import { isLoopbackHost } from '@/lib/loopback'
import { isCloudEdition } from '@/lib/edition'
import { CodedError } from '@mikka/protocol/coded-error'

type AuthEnvironment = Record<string, string | undefined>
export const MOBILE_APP_ORIGIN = 'mikka://'

/** Native Apple credentials use the app bundle as their audience. */
export function authAppleOptions(env: AuthEnvironment) {
  const bundle = env.APPLE_APP_BUNDLE_IDENTIFIER?.trim() || (isCloudEdition(env) ? 'com.aspectlylabs.mikka' : undefined)
  return bundle ? { clientId: bundle, appBundleIdentifier: bundle, requireEmailVerification: true } : undefined
}

/** Reject relayed credentials before Better Auth verifies Apple's signature and claims. */
export function requireAppleSignInNonce(ctx: {
  path?: string
  body?: { provider?: unknown; idToken?: { nonce?: unknown; token?: unknown } }
  context: { baseURL: string }
}) {
  if (ctx.path !== '/sign-in/social' || ctx.body?.provider !== 'apple' || !ctx.body.idToken) return
  const { nonce, token } = ctx.body.idToken
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const authURL = new URL(ctx.context.baseURL).href.replace(/\/$/, '')
  let claim: unknown
  if (typeof token === 'string') {
    try { claim = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).nonce } catch { /* Invalid credentials are refused below. */ }
  }
  if (typeof nonce !== 'string' || !/^[0-9a-f]{64}\.[0-9a-f]{64}$/.test(nonce)
    || nonce.slice(65) !== hash(authURL) || claim !== hash(nonce)) {
    throw new APIError('UNAUTHORIZED', { code: 'INVALID_TOKEN', message: 'Invalid token' })
  }
}

export function authSignInMethods(env: AuthEnvironment) {
  return { google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET), apple: Boolean(authAppleOptions(env)), email: true }
}

export function resolveAppOrigin(env: AuthEnvironment) {
  const deployment = env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined
  const production = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined
  return (env.BETTER_AUTH_URL ?? (env.VERCEL_ENV === 'preview' ? deployment : production ?? deployment)
    ?? env.V0_RUNTIME_URL ?? env.V0_DEV_APP_URL ?? env.V0_BUILD_URL ?? env.V0_SANDBOX_URL ?? env.CF_PAGES_URL)?.replace(/\/$/, '')
}

function httpsOrigin(value: string, allowLoopback = false) {
  const url = new URL(value)
  const loopback = allowLoopback && url.protocol === 'http:' && isLoopbackHost(url.hostname)
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname === '*') {
    throw new Error('Auth origins must be HTTPS (or HTTP loopback in community/development/CI) without credentials, paths, queries or fragments')
  }
  return url.origin
}

/**
 * HTTP loopback origins are allowed in development, hosted CI, and a production
 * build serving the local test-account mode (docs/test-accounts.md): its switch
 * is on and every configured database is a loopback *_e2e database.
 */
function loopbackAllowed(env: AuthEnvironment) {
  return !isCloudEdition(env) || env.NODE_ENV === 'development' || env.CI === 'true' || localTestAccountsMode(env)
}

export function authTrustedOrigins(env: AuthEnvironment) {
  return [...new Set([
    resolveAppOrigin(env),
    env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined,
    env.VERCEL_BRANCH_URL ? `https://${env.VERCEL_BRANCH_URL}` : undefined,
    env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined,
    env.V0_RUNTIME_URL, env.V0_DEV_APP_URL, env.V0_BUILD_URL, env.V0_SANDBOX_URL, env.CF_PAGES_URL,
  ].filter((value): value is string => Boolean(value)).map(value => httpsOrigin(value, loopbackAllowed(env))).concat(
    (env.AUTH_TRUSTED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
      .map(value => value === MOBILE_APP_ORIGIN ? value : httpsOrigin(value, loopbackAllowed(env))),
  ))]
}

/** One source for Better Auth and discovery. Official cloud keeps its existing
 * mobile integration; community administrators explicitly enable the scheme. */
export function authEffectiveTrustedOrigins(env: AuthEnvironment) {
  return [...new Set([
    ...authTrustedOrigins(env),
    ...(isCloudEdition(env) ? [MOBILE_APP_ORIGIN] : []),
    ...(env.NODE_ENV === 'development' ? ['http://localhost:3000', 'exp://'] : []),
  ])]
}

export function authOAuthProxyOptions(env: AuthEnvironment) {
  if (!isCloudEdition(env) && (env.BETTER_AUTH_OAUTH_PROXY_URL || env.BETTER_AUTH_OAUTH_PROXY_SECRET)) {
    throw new CodedError('SELF_HOSTED_OAUTH_PROXY_UNSUPPORTED')
  }
  if (!env.BETTER_AUTH_OAUTH_PROXY_URL || !env.BETTER_AUTH_OAUTH_PROXY_SECRET) return undefined
  const productionURL = httpsOrigin(env.BETTER_AUTH_OAUTH_PROXY_URL)
  if (productionURL.includes('*')) throw new Error('The OAuth proxy hub must use an exact HTTPS origin')
  return { productionURL, secret: env.BETTER_AUTH_OAUTH_PROXY_SECRET }
}
