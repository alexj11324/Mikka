import { randomBytes } from 'node:crypto'

/**
 * The system URL scheme of this build. It only asks the app to come to the
 * front after a browser sign-in; it carries no code, token or page. It is not
 * the internal `mikka://app/…` scheme that serves the bundled renderer, so an
 * outside link can never reach that protocol handler. Dev builds get their own
 * scheme so a "Mikka Dev" and an installed Mikka never take each other's links.
 */
export function appLinkScheme(flavor: string): string {
  return flavor === 'dev' ? 'mikka-dev-auth' : 'mikka-auth'
}

const ID = /^[A-Za-z0-9_-]{32,64}$/
const TTL_MS = 10 * 60_000
const LIMIT = 8

export function appLinkUrl(scheme: string, id: string): string {
  return `${scheme}://auth/done?id=${id}`
}

/** The id of `<scheme>://auth/done?id=<id>`, or null for anything else. */
export function parseAppLink(raw: unknown, scheme: string): string | null {
  // The exact prefix also rules out user info and a port before the host.
  if (typeof raw !== 'string' || raw.length > 256 || !raw.toLowerCase().startsWith(`${scheme}://auth/done?`)) return null
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== `${scheme}:` || url.host !== 'auth' || url.pathname !== '/done' || url.hash) return null
  const keys = [...url.searchParams.keys()]
  const id = url.searchParams.get('id')
  return keys.length === 1 && keys[0] === 'id' && id && ID.test(id) ? id : null
}

/** Windows and Linux pass an opened link to the running app as a command-line argument. */
export function appLinkFromArgv(argv: readonly string[], scheme: string): string | null {
  return argv.find(arg => arg.toLowerCase().startsWith(`${scheme}:`)) ?? null
}

/**
 * Links this app handed to a sign-in callback page. A link counts only while
 * its sign-in is recent; the page's 「打开 Mikka」 button may open it again.
 */
export class AppLinks {
  private readonly pending = new Map<string, number>()
  constructor(readonly scheme: string, private readonly now: () => number = Date.now) {}

  issue(): string {
    this.prune()
    while (this.pending.size >= LIMIT) this.pending.delete(this.pending.keys().next().value!)
    const id = randomBytes(24).toString('base64url')
    this.pending.set(id, this.now() + TTL_MS)
    return appLinkUrl(this.scheme, id)
  }

  accepts(raw: unknown): boolean {
    this.prune()
    const id = parseAppLink(raw, this.scheme)
    return id !== null && this.pending.has(id)
  }

  private prune(): void {
    const now = this.now()
    for (const [id, expires] of this.pending) if (expires <= now) this.pending.delete(id)
  }
}
