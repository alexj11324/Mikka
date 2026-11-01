// Who may apply migrations to which database. On 2026-10-25 an unmerged
// branch's migrations reached production from outside a main deploy; this
// refuses both routes that allow that:
// - Vercel production applies migrations only from main.
// - Outside Vercel, MIGRATE=1 only reaches loopback databases, unless the
//   caller passes --allow-remote (which prints a warning).
export function migrationGuard(env, targets, argv = []) {
  if (env.VERCEL_ENV === 'production') {
    if (env.VERCEL_GIT_COMMIT_REF !== 'main') {
      throw new Error(`migrate: refused: production migrations run only from main (VERCEL_GIT_COMMIT_REF=${env.VERCEL_GIT_COMMIT_REF || '<unset>'})`)
    }
    return { warning: null }
  }
  if (env.VERCEL === '1') return { warning: null }
  const remote = Object.entries(targets).filter(([, url]) => url && !isLoopbackDatabase(url)).map(([name]) => name)
  if (!remote.length) return { warning: null }
  if (!argv.includes('--allow-remote')) {
    throw new Error(`migrate: refused: ${remote.join(', ')} is not a loopback database; outside Vercel pass --allow-remote to migrate it`)
  }
  return { warning: `migrate: WARNING --allow-remote: applying migrations to non-loopback ${remote.join(', ')}` }
}

/** Whether to migrate without being asked: Vercel production, or off Vercel when every configured target is loopback. */
export function migrationRequested(env, targets) {
  if (env.MIGRATE === '0') return false
  if (env.MIGRATE === '1' || env.VERCEL_ENV === 'production') return true
  if (env.VERCEL || env.VERCEL_ENV) return false
  const urls = Object.values(targets).filter(Boolean)
  return urls.length > 0 && urls.every(isLoopbackDatabase)
}

export function isLoopbackDatabase(connectionString) {
  let url
  try { url = new URL(connectionString) } catch { return false }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return false
  const socket = url.searchParams.get('host')
  const host = socket ?? url.hostname
  return host === '' || host.startsWith('/') || host === 'localhost' || host === '[::1]' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}
