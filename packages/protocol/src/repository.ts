import { localTestAccountsMode } from '@mikka/protocol/local-test-mode'
/** Repository identity and clone input shared by the server and daemon. */
export interface Repository {
  remoteUrl: string
  /** Logical identity, never a path in a person's checkout. */
  key: string
}

/** Versioned authorization/cache identity; transport permission is checked separately. */
export function remoteKey(url: string): string {
  return normalizeRepository(url, { allowFile: true }).key
}

/** Unversioned/ambiguous scheduling records must not retarget a queued run. */
export function repositoryBindingMatches(key: string, url: string | null, options: { allowFile?: boolean } = {}): boolean {
  try { return url !== null && normalizeRepository(url, options).key === key } catch { return false }
}

/** The explicit test switch can never enable mock/local origins in production. */
export function daemonTestMode(env: Record<string, string | undefined>): boolean {
  return env.VERCEL_ENV !== 'production' && env.MIKKA_TEST_MODE === '1'
    && (env.NODE_ENV === 'test' || env.CI === 'true' || env.VERCEL_ENV === 'preview' || localTestAccountsMode(env))
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
    return { remoteUrl: file.href, key: `v2/file/localhost${file.pathname}` }
  }
  if (/(^|[/:])\.{1,2}(?:\/|$)/.test(raw) || raw.includes('%')) throw invalid()
  let host: string
  let path: string
  let transport: 'https' | 'ssh'
  let port: string
  let user: string
  let pathKind: 'absolute' | 'relative' = 'absolute'
  if (/^(https|ssh):\/\//i.test(raw)) {
    const url = new URL(raw)
    if (!url.hostname || url.search || url.hash || url.password || (url.protocol === 'https:' && url.username)) throw invalid()
    host = url.hostname
    path = url.pathname.replace(/^\//, '')
    transport = url.protocol === 'https:' ? 'https' : 'ssh'
    port = url.port || (transport === 'https' ? '443' : '22')
    user = url.username
    if (user && !/^[A-Za-z0-9_.-]+$/.test(user)) throw invalid()
    // Clone the same parsed endpoint used to derive identity, rather than
    // asking git to reinterpret a differently normalized URL string.
    raw = url.href
  } else {
    const scp = /^(?:([A-Za-z0-9_.-]+)@)?([A-Za-z0-9.-]+):([^/].*)$/.exec(raw)
    if (!scp || scp[2]!.length === 1 || scp[3]!.startsWith(':')) throw invalid()
    user = scp[1] ?? ''
    host = scp[2]!
    path = scp[3]!
    transport = 'ssh'
    port = '22'
    pathKind = 'relative'
  }
  if (!/^[A-Za-z0-9.-]+$/.test(host) || host === '.' || host === '..') throw invalid()
  const parts = path.replace(/\/+$/, '').replace(/\.git$/, '').split('/')
  if (parts.length < 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..' || part.startsWith('-'))) throw invalid()
  host = host.toLowerCase()
  // An omitted SSH login resolves to this machine's OS user and may name a
  // different namespace on another device. It cannot carry a shared approval.
  if (transport === 'ssh' && !user) throw invalid()
  // Only GitHub's documented standard endpoints identify the same repository
  // across transports. Other servers may route by port, SSH login, path case,
  // absolute/relative namespace, or the literal .git suffix.
  const github = host === 'github.com' && parts.length === 2
    && (transport === 'https' && port === '443' || transport === 'ssh' && port === '22' && user === 'git')
  const namespace = transport === 'ssh' ? `user/${user}/${pathKind}/` : ''
  const key = github ? `v2/github.com/${parts.join('/').toLowerCase()}`
    : `v2/${transport}/${host}/${port}/${namespace}${path}`
  return { remoteUrl: raw, key }
}
