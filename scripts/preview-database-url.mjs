/** Require an explicit Preview endpoint and prevent inherited password use. */
export function previewDatabaseURL(env) {
  const value = env.DATABASE_URL
  if (!value?.trim()) throw new Error('PREVIEW_DATABASE_URL_REQUIRED')
  try {
    if (value !== value.trim()) throw new Error()
    const url = new URL(value)
    const database = decodeURIComponent(url.pathname.slice(1))
    const user = decodeURIComponent(url.username)
    const overrides = ['host', 'hostaddr', 'port', 'dbname', 'database', 'user', 'password']
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !user.trim() || !database.trim() || database.includes('/') || url.hash ||
      (!url.password && env.PGPASSWORD) ||
      [...url.searchParams.keys()].some(key => overrides.includes(key.toLowerCase()))) throw new Error()
    // pg otherwise takes PGPORT from the surrounding environment when the
    // connection string omits a port, even with an explicit host and database.
    if (!url.port) url.port = '5432'
    return url.href
  } catch { throw new Error('PREVIEW_DATABASE_URL_INVALID') }
}
