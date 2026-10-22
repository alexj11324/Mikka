type AuthEnvironment = Record<string, string | undefined>

export function resolveAppOrigin(env: AuthEnvironment) {
  const deployment = env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined
  const production = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined
  return (env.BETTER_AUTH_URL ?? (env.VERCEL_ENV === 'preview' ? deployment : production ?? deployment)
    ?? env.V0_RUNTIME_URL ?? env.V0_DEV_APP_URL ?? env.V0_BUILD_URL ?? env.V0_SANDBOX_URL ?? env.CF_PAGES_URL)?.replace(/\/$/, '')
}

function httpsOrigin(value: string, allowCILoopback = false) {
  const url = new URL(value)
  const ciLoopback = allowCILoopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !ciLoopback) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname === '*') {
    throw new Error('Auth origins must be HTTPS (or HTTP loopback in CI) without credentials, paths, queries or fragments')
  }
  return url.origin
}

export function authTrustedOrigins(env: AuthEnvironment) {
  return [...new Set([
    resolveAppOrigin(env),
    env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined,
    env.VERCEL_BRANCH_URL ? `https://${env.VERCEL_BRANCH_URL}` : undefined,
    env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined,
    env.V0_RUNTIME_URL, env.V0_DEV_APP_URL, env.V0_BUILD_URL, env.V0_SANDBOX_URL, env.CF_PAGES_URL,
    ...(env.AUTH_TRUSTED_ORIGINS ?? '').split(',').map(value => value.trim()),
  ].filter((value): value is string => Boolean(value)).map(value => httpsOrigin(value, env.CI === 'true' || env.NODE_ENV === 'development')))]
}

export function authOAuthProxyOptions(env: AuthEnvironment) {
  if (!env.BETTER_AUTH_OAUTH_PROXY_URL || !env.BETTER_AUTH_OAUTH_PROXY_SECRET) return undefined
  const productionURL = httpsOrigin(env.BETTER_AUTH_OAUTH_PROXY_URL)
  if (productionURL.includes('*')) throw new Error('The OAuth proxy hub must use an exact HTTPS origin')
  return { productionURL, secret: env.BETTER_AUTH_OAUTH_PROXY_SECRET }
}
