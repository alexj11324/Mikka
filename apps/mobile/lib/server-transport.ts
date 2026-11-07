/** Better Auth's cookie jar is bound to this origin/base path for its lifetime. */
export function boundAuthFetch(server: string, fetcher: typeof fetch): typeof fetch {
  const base = new URL(server)
  const prefix = `${base.pathname.replace(/\/$/, '')}/api/auth/`
  return (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) throw new Error('mobile_auth_target_invalid')
    return fetcher(input, { ...init, redirect: 'error' })
  }
}
