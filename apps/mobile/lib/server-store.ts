import { CLOUD_API_URL, serverAddress, serverUrl, type MobileServer } from './server-discovery'
export type { MobileServer } from './server-discovery'

export type SavedAccount = { id: string; server: MobileServer; user: { id: string; name: string; email: string } | null }
type Stored = { version: 1; active: string; next: number; accounts: SavedAccount[] }
export type ServerSnapshot = Stored & { ready: boolean }
export const SERVER_STORE_KEY = 'mikka_accounts_v1'
export const accountStorageKey = (id: string, suffix: string) => `${id === 'legacy' ? 'mikka' : `mikka_account_${id}`}_${suffix}`

/** Account slots bind cookies to an immutable server before the first login.
 * Different accounts on the same server also have separate cookie jars. */
export class MobileServerStore {
  private state: ServerSnapshot
  private listeners = new Set<() => void>()
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly storage: { getItemAsync(key: string): Promise<string | null>; setItemAsync(key: string, value: string): Promise<void> }, defaultServer: MobileServer) {
    this.state = { version: 1, active: 'legacy', next: 1, ready: false, accounts: [{ id: 'legacy', server: defaultServer, user: null }] }
  }
  snapshot = () => this.state
  current = () => this.state.accounts.find(account => account.id === this.state.active)!
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(next: ServerSnapshot) { this.state = next; for (const listener of this.listeners) listener() }
  async initialize() {
    if (this.state.ready) return
    const raw = await this.storage.getItemAsync(SERVER_STORE_KEY)
    if (!raw) { this.publish({ ...this.state, ready: true }); return }
    const stored = JSON.parse(raw) as Stored
    if (stored.version !== 1 || !Number.isSafeInteger(stored.next) || stored.next < 1 || !Array.isArray(stored.accounts)
      || !stored.accounts.length || !stored.accounts.some(account => account.id === stored.active)) throw new Error('mobile_accounts_invalid')
    const ids = new Set<string>()
    for (const account of stored.accounts) {
      const address = serverAddress(account.server?.url)
      if (!/^(?:legacy|[1-9][0-9]*)$/.test(account.id) || ids.has(account.id) || typeof address === 'string' || serverUrl(address) !== account.server.url
        || account.id !== 'legacy' && (!Number.isSafeInteger(Number(account.id)) || Number(account.id) >= stored.next)
        || typeof account.server.name !== 'string' || !account.server.signIn || typeof account.server.mobileReady !== 'boolean'
        || account.user && (typeof account.user.id !== 'string' || typeof account.user.name !== 'string' || typeof account.user.email !== 'string')) throw new Error('mobile_accounts_invalid')
      account.server.signIn.apple = account.server.signIn.apple === true
        || account.server.signIn.apple === undefined && account.server.url === CLOUD_API_URL
      ids.add(account.id)
    }
    this.publish({ ...stored, ready: true })
  }
  private update(work: (state: ServerSnapshot) => ServerSnapshot) {
    const next = this.pending.then(async () => {
      const state = work(this.state)
      const { ready: _ready, ...stored } = state
      const value = JSON.stringify(stored)
      await this.storage.setItemAsync(SERVER_STORE_KEY, value)
      // Better Auth's chunking adapter logs native write failures. Verify the
      // durable value before publishing a new credential namespace.
      if (await this.storage.getItemAsync(SERVER_STORE_KEY) !== value) throw new Error('mobile_accounts_save_failed')
      this.publish(state)
    })
    this.pending = next.catch(() => undefined)
    return next
  }
  async add(server: MobileServer) {
    await this.update(state => {
      const id = String(state.next)
      return { ...state, active: id, next: state.next + 1, accounts: [...state.accounts, { id, server, user: null }] }
    })
  }
  async select(id: string) {
    await this.update(state => {
      if (!state.accounts.some(account => account.id === id)) throw new Error('mobile_account_missing')
      return { ...state, active: id }
    })
  }
  async remember(id: string, user: NonNullable<SavedAccount['user']>) {
    const previous = this.state.accounts.find(account => account.id === id)?.user
    if (previous?.id === user.id && previous.name === user.name && previous.email === user.email) return
    await this.update(state => ({ ...state, accounts: state.accounts.map(account => account.id === id ? { ...account, user } : account) }))
  }
  async describe(id: string, server: MobileServer) {
    await this.update(state => ({ ...state, accounts: state.accounts.map(account => {
      if (account.id !== id) return account
      if (account.server.url !== server.url) throw new Error('mobile_account_server_changed')
      return { ...account, server }
    }) }))
  }
  async signedOut(id: string) {
    await this.update(state => ({ ...state, accounts: state.accounts.map(account => account.id === id ? { ...account, user: null } : account) }))
  }
}
