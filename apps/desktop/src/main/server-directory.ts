import { readFileSync } from 'node:fs'
import { mkdir, open, rename } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalServerUrl, type DiscoveredServer, type ServerSignIn } from './server-discovery'

/** What the app knows about a server: public discovery facts only, never a credential. */
export interface KnownServer { url: string; name: string | null; version: string | null; edition: 'cloud' | 'community' | null; signIn: ServerSignIn | null }
const MAX_FILE = 64 * 1024
const MAX_SERVERS = 20
const PROBE_TTL = 10 * 60_000

function known(value: unknown): KnownServer | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  let url: string
  try { url = canonicalServerUrl(String(item.url)) } catch { return null }
  const short = (field: unknown, max: number) => typeof field === 'string' && field.length <= max ? field : null
  const signIn = item.signIn && typeof item.signIn === 'object' ? item.signIn as Record<string, unknown> : null
  return {
    url, name: short(item.name, 200), version: short(item.version, 100),
    edition: item.edition === 'cloud' || item.edition === 'community' ? item.edition : null,
    signIn: signIn ? { google: signIn.google === true, github: signIn.github === true, email: signIn.email === true } : null,
  }
}

/**
 * Which server the sign-in page targets and the public facts each server
 * reported when it was probed. Kept beside the encrypted session vault as plain
 * JSON: it holds addresses and names, nothing that signs anyone in. A server
 * becomes selectable only through a probe this process made in the last ten
 * minutes (or the built-in cloud), never from a renderer-supplied description.
 */
export class ServerDirectory {
  readonly cloud: string
  private selected: string
  private readonly servers = new Map<string, KnownServer>()
  private readonly probed = new Map<string, { server: DiscoveredServer; at: number }>()
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly file: string, cloudUrl: string, private readonly now: () => number = Date.now) {
    this.cloud = canonicalServerUrl(cloudUrl)
    this.selected = this.cloud
    try {
      const raw = readFileSync(file)
      if (raw.length > MAX_FILE) return
      const parsed = JSON.parse(raw.toString('utf8')) as { version?: unknown; target?: unknown; servers?: unknown }
      if (parsed.version !== 1 || !Array.isArray(parsed.servers)) return
      for (const item of parsed.servers.slice(0, MAX_SERVERS)) {
        const server = known(item)
        if (server && server.url !== this.cloud) this.servers.set(server.url, server)
      }
      const target = typeof parsed.target === 'string' ? canonicalServerUrl(parsed.target) : this.cloud
      if (target === this.cloud || this.servers.has(target)) this.selected = target
    } catch { /* No file yet, or an unreadable one: start on the cloud. */ }
  }

  target(): string { return this.selected }
  info(url: string): KnownServer {
    const key = canonicalServerUrl(url)
    if (key === this.cloud) return { url: key, name: null, version: null, edition: 'cloud', signIn: null }
    return this.servers.get(key) ?? { url: key, name: null, version: null, edition: null, signIn: null }
  }
  isCloud(url: string): boolean { return canonicalServerUrl(url) === this.cloud }

  /** Remembers one successful probe so the person can then choose it. */
  probedServer(server: DiscoveredServer): void {
    const now = this.now()
    for (const [url, entry] of this.probed) if (now - entry.at > PROBE_TTL) this.probed.delete(url)
    this.probed.set(server.url, { server, at: now })
  }

  /** The cloud, a server probed in the last ten minutes, or an already known one. */
  select(url: string | null): string {
    const key = url === null ? this.cloud : canonicalServerUrl(url)
    if (key !== this.cloud) {
      const probe = this.probed.get(key)
      if (probe && this.now() - probe.at <= PROBE_TTL) {
        const { server } = probe
        this.servers.set(key, { url: key, name: server.name, version: server.version, edition: server.edition, signIn: server.signIn })
      } else if (!this.servers.has(key)) throw new Error('desktop_server_not_probed')
    }
    this.selected = key
    void this.save()
    return key
  }

  /** The sign-in page follows the selected account to its server, which was
   * probed when that account signed in. */
  follow(url: string): void {
    const key = canonicalServerUrl(url)
    if (key !== this.cloud && !this.servers.has(key)) this.servers.set(key, { url: key, name: null, version: null, edition: null, signIn: null })
    if (this.selected === key) return
    this.selected = key
    void this.save()
  }

  /** Forgets a disconnected server; the sign-in page returns to the cloud. */
  forget(url: string): void {
    const key = canonicalServerUrl(url)
    if (key === this.cloud) return
    this.servers.delete(key); this.probed.delete(key)
    if (this.selected === key) this.selected = this.cloud
    void this.save()
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, target: this.selected, servers: [...this.servers.values()].slice(-MAX_SERVERS) })
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${process.pid}.tmp`
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(snapshot) } finally { await handle.close() }
      await rename(temporary, this.file)
    }).catch(() => { /* A preference that fails to save falls back to the cloud next launch. */ })
    return this.pending
  }
  saved(): Promise<void> { return this.pending }
}
