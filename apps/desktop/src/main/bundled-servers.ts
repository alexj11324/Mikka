import type { BundledServer, BundledServerProbe, BundledServerState } from '@mikka/protocol/bridge'
import type { BundledAuth } from './bundled-auth'
import type { ServerDirectory } from './server-directory'
import { probeServer } from './server-discovery'

type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/** Settings and the sign-in page's view of servers (#1557). Every answer is
 * built in main from its own probe and vault; the renderer only names a URL. */
export class BundledServers {
  constructor(
    private readonly auth: Pick<BundledAuth, 'serverUrl' | 'targetUrl' | 'serverAccounts' | 'setTarget' | 'signOutServer' | 'whenRestored'>,
    private readonly directory: ServerDirectory,
    private readonly options: { fetch: Fetcher; appVersion: string; enforceMinimum: boolean },
  ) {}

  describe(url: string, accounts = this.auth.serverAccounts()): BundledServer {
    const known = this.directory.info(url)
    return { url: known.url, cloud: this.directory.isCloud(known.url), name: known.name, version: known.version, accounts: accounts.get(known.url) ?? 0, signIn: known.signIn }
  }

  async state(): Promise<BundledServerState> {
    await this.auth.whenRestored()
    const accounts = this.auth.serverAccounts()
    const urls = new Set([this.directory.cloud, ...accounts.keys()])
    return { current: this.describe(this.auth.serverUrl(), accounts), target: this.describe(this.auth.targetUrl(), accounts), servers: [...urls].map(url => this.describe(url, accounts)) }
  }

  async probe(address: unknown): Promise<BundledServerProbe> {
    const result = await probeServer(address, this.options)
    if (result.status !== 'ok') return result
    this.directory.probedServer(result.server)
    const { url, name, version, signIn } = result.server
    return { status: 'ok', server: { url, cloud: this.directory.isCloud(url), name, version, accounts: this.auth.serverAccounts().get(url) ?? 0, signIn } }
  }

  async select(url: unknown): Promise<BundledServerState> {
    if (url !== null && typeof url !== 'string') throw new Error('Invalid server')
    await this.auth.setTarget(this.directory.select(url))
    return this.state()
  }

  async disconnect(url: unknown): Promise<BundledServerState> {
    if (typeof url !== 'string') throw new Error('Invalid server')
    await this.auth.signOutServer(url)
    this.directory.forget(url)
    return this.state()
  }
}
