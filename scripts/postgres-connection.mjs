// Preserve the existing database, role, password and TLS settings. Only a
// documented Neon endpoint may switch from the transaction pooler to direct.
const routingOverrides = new Set(['host', 'hostname', 'hostaddr', 'port', 'dbname', 'database', 'user', 'password', 'connectionstring'])
export function directDatabaseURL(value) {
  if (value == null || value === '') return value
  let url
  try { url = new URL(value) } catch { throw new Error('DATABASE_CONNECTION_URL_INVALID') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_CONNECTION_URL_INVALID')
  if (!url.hostname.endsWith('.neon.tech')) return value
  if (!/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname)) throw new Error('NEON_ENDPOINT_HOST_INVALID')
  if ([...url.searchParams.keys()].some(key => routingOverrides.has(key.toLowerCase()))) throw new Error('NEON_CONNECTION_OVERRIDE_REFUSED')
  url.hostname = url.hostname.replace(/-pooler(?=\.)/, '')
  return url.href
}

/** An explicit self-hosted direct URI belongs only to its configured pool.
 * Request-scoped, preview and separate workspace targets retain their own identity. */
export function sessionDatabaseURL(value, env = process.env) {
  const derived = directDatabaseURL(value)
  if (value && !env.VERCEL && !env.VERCEL_ENV && value === env.MIKKA_DATABASE_URL && env.MIKKA_DATABASE_URL_UNPOOLED) {
    return directDatabaseURL(env.MIKKA_DATABASE_URL_UNPOOLED)
  }
  return derived
}

export function directPoolOptions(options) {
  const result = { ...options }
  if (result.connectionString) {
    const direct = sessionDatabaseURL(result.connectionString)
    const original = new URL(result.connectionString)
    if (result.host && result.host !== original.hostname) throw new Error('DATABASE_CONNECTION_HOST_CONFLICT')
    if (result.host) result.host = new URL(direct).hostname
    result.connectionString = direct
  }
  if (result.host?.endsWith('.neon.tech')) {
    const host = directDatabaseURL(`postgresql://${result.host}/postgres`)
    result.host = new URL(host).hostname
  }
  return result
}
