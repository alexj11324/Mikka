/** Repository identity and clone input shared by the server and daemon. */
export interface Repository {
  remoteUrl: string
  /** Logical identity, never a path in a person's checkout. */
  key: string
}

/** Same identity for HTTPS, SSH and scp spellings of a repository. */
export function remoteKey(url: string): string {
  return url.trim().toLowerCase().replace(/^file:\/\/\//, 'file/localhost/')
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d+\/)/, '$1/')
    .replace(/:\d+\//, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
}

/** The explicit test switch can never enable mock/local origins in production. */
export function daemonTestMode(env: Record<string, string | undefined>): boolean {
  return env.VERCEL_ENV !== 'production' && env.MIKKA_TEST_MODE === '1'
    && (env.NODE_ENV === 'test' || env.CI === 'true' || env.VERCEL_ENV === 'preview')
}

/**
 * Accept a GitHub owner/repo, HTTPS clone URL, SSH URL or scp URL. Git's
 * executable transports and paths on the machine are never accepted. File
 * origins exist only for an explicitly isolated test environment.
 */
export function normalizeRepository(input: string, options: { allowFile?: boolean } = {}): Repository {
  let raw = input.trim()
  const invalid = () => new Error('Invalid repository: use owner/repo, HTTPS or SSH.')
  if (!raw || raw.length > 4_000 || /[\s\u0000-\u001f\u007f\\]/.test(raw)) throw invalid()
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) raw = `https://github.com/${raw.replace(/\.git$/, '')}.git`
  if (raw.startsWith('file://')) {
    if (!options.allowFile) throw invalid()
    const file = new URL(raw)
    if (file.hostname || file.search || file.hash || !file.pathname.startsWith('/') || file.pathname === '/') throw invalid()
    // The complete encoded path is retained: two disposable origins must not
    // share a cache because their basenames happen to match.
    return { remoteUrl: file.href, key: remoteKey(file.href) }
  }
  if (/(^|[/:])\.{1,2}(?:\/|$)/.test(raw) || raw.includes('%')) throw invalid()
  let host: string
  let path: string
  if (/^(https|ssh):\/\//i.test(raw)) {
    const url = new URL(raw)
    if (!url.hostname || url.search || url.hash || url.password || (url.protocol === 'https:' && url.username)) throw invalid()
    host = url.hostname
    path = url.pathname.replace(/^\//, '')
  } else {
    const scp = /^(?:[A-Za-z0-9_.-]+@)?([A-Za-z0-9.-]+):([^/].*)$/.exec(raw)
    if (!scp || scp[1]!.length === 1 || scp[2]!.startsWith(':')) throw invalid()
    host = scp[1]!
    path = scp[2]!
  }
  if (!/^[A-Za-z0-9.-]+$/.test(host) || host === '.' || host === '..') throw invalid()
  const parts = path.replace(/\/+$/, '').replace(/\.git$/, '').split('/')
  if (parts.length < 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..' || part.startsWith('-'))) throw invalid()
  const key = remoteKey(raw)
  if (!key.startsWith(`${host.toLowerCase()}/`)) throw invalid()
  return { remoteUrl: raw, key }
}
