import { canonicalWebServer } from './policy'
import { probeWebServer, type WebFetch, type WebServer, type WebServerProbe } from './discovery'
import type { DesktopSession } from '../desktop-rpc/wire'
import { selectedWorkspaceId, WORKSPACE_SELECTION_HEADER } from '../workspace-selection'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type WebServerAccount = DesktopSession & { server: string }
type Credential = WebServerAccount & { token: string; workspaceId?: string }
export type WebServerEntry = WebServer & { active: boolean; accounts: WebServerAccount[] }
type Pending = { state: string; verifier: string; callback: string; server: WebServer; expiresAt: number; version: number }
const directoryKey = 'mikka.web.servers.v1', sessionKey = 'mikka.web.sessions.v1'
const tokenPattern = /^[A-Za-z0-9_.%~+/-]{32,512}$/
const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const safeSession = (credential: Credential): WebServerAccount => ({ server: credential.server,
  user: { id: credential.user.id, name: credential.user.name, email: credential.user.email, image: typeof credential.user.image === 'string' ? credential.user.image : null, emailVerified: credential.user.emailVerified },
  session: { id: credential.session.id } })
const validSessionToken = (value: unknown): value is string => typeof value === 'string' && tokenPattern.test(value) && !/^(?:mkp_|mka_|mkr_)/.test(value)
const validText = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const workspaceActions = new Set(['workspace.switchWorkspace', 'workspace.createWorkspace', 'workspace.acceptWorkspaceInvitation'])
async function selectsWorkspace(request: Request, path: string) {
  if (path !== '/api/desktop/rpc' || request.method !== 'POST') return false
  try { return workspaceActions.has((await request.clone().json())?.action) }
  catch { return false } // The RPC handler owns malformed-body rejection.
}

export class WebConnectionError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); this.name = 'WebConnectionError' }
}

/** Owns server credentials only in this browser's session storage. Its public
 * snapshots contain no token. Persistent directory entries are untrusted input
 * and never become sign-in targets until a fresh probe succeeds. */
export class WebServerDirectory {
  private servers = new Map<string, WebServer>()
  private credentials = new Map<string, Credential>()
  private cloudUsers = new Set<string>()
  private probed = new Map<string, number>()
  private pending = new Map<string, Pending>()
  private activeId: string | null = null
  private expiredServer: string | null = null
  private generation = 0
  private workspaceGeneration = 0
  private workspaceIntent = 0
  private requestSequence = 0
  private responseVersions = new WeakMap<Response, { account: number; workspace: number }>()
  private requests = new AbortController()
  private listeners = new Set<() => void>()
  private snapshot: { version: number; account: WebServerAccount | null; expiredServer: string | null } = { version: 0, account: null, expiredServer: null }
  readonly app: URL

  constructor(private options: { appUrl: string; fetch: WebFetch; storage?: StorageLike; sessionStorage?: StorageLike; now?: () => number; onChange?: () => Promise<void> | void }) {
    const app = canonicalWebServer(options.appUrl)
    if (!app) throw new WebConnectionError('web_connection_app_invalid')
    this.app = new URL(app)
    this.restore()
    this.updateSnapshot()
  }
  private now() { return (this.options.now ?? Date.now)() }
  private key(server: string, userId: string) { return JSON.stringify([server, userId]) }
  private restore() {
    try {
      const saved = JSON.parse(this.options.storage?.getItem(directoryKey) ?? 'null')
      if (saved?.version === 1 && Array.isArray(saved.servers)) for (const server of saved.servers.slice(0, 20)) {
        if (canonicalWebServer(server?.url) === server.url && validText(server.name) && validText(server.version) && ['cloud', 'community'].includes(server.edition)
          && server.signIn && ['email', 'google', 'github'].every(key => typeof server.signIn[key] === 'boolean')) this.servers.set(server.url, server)
      }
      if (Array.isArray(saved?.cloudUsers)) for (const id of saved.cloudUsers) if (validText(id)) this.cloudUsers.add(id)
      const sessions = JSON.parse(this.options.sessionStorage?.getItem(sessionKey) ?? 'null')
      if (sessions?.version === 1 && Array.isArray(sessions.credentials)) for (const credential of sessions.credentials.slice(0, 20)) {
        if (!this.validCredential(credential) || this.conflicts(credential.server, credential.user.id)) continue
        this.credentials.set(this.key(credential.server, credential.user.id), credential)
      }
      if (typeof sessions?.active === 'string' && this.credentials.has(sessions.active)) this.activeId = sessions.active
      else if (sessions?.version === 1 && this.servers.has(sessions.expiredServer)) this.expiredServer = sessions.expiredServer
    } catch { /* A malformed directory cannot select an origin or invent authority. */ }
  }
  private persist() {
    try { this.options.storage?.setItem(directoryKey, JSON.stringify({ version: 1, servers: [...this.servers.values()], cloudUsers: [...this.cloudUsers] })) } catch { /* Memory remains usable when storage is unavailable. */ }
    try {
      if (this.credentials.size || this.expiredServer) this.options.sessionStorage?.setItem(sessionKey, JSON.stringify({ version: 1, credentials: [...this.credentials.values()], active: this.activeId, expiredServer: this.expiredServer }))
      else this.options.sessionStorage?.removeItem(sessionKey)
    } catch { /* Credentials never fall back to persistent directory storage. */ }
  }
  private validCredential(value: unknown, pendingServer?: string): value is Credential {
    if (!value || typeof value !== 'object') return false
    const item = value as Credential
    return (this.servers.has(item.server) || pendingServer !== undefined && item.server === pendingServer) && validSessionToken(item.token) && validText(item.user?.id) && typeof item.user.name === 'string'
      && typeof item.user.email === 'string' && typeof item.user.emailVerified === 'boolean' && validText(item.session?.id)
      && (item.workspaceId === undefined || selectedWorkspaceId(item.workspaceId) === item.workspaceId)
  }
  private conflicts(server: string, userId: string) {
    return this.cloudUsers.has(userId) || [...this.credentials.values()].some(item => item.user.id === userId && item.server !== server)
  }
  private updateSnapshot() { const active = this.active(); this.snapshot = { version: this.generation, account: active ? safeSession(active) : null, expiredServer: this.expiredServer } }
  private async changed() {
    this.generation++
    this.workspaceGeneration++
    this.workspaceIntent = ++this.requestSequence
    // A server/account/session transition cannot inherit another context's choice.
    for (const credential of this.credentials.values()) delete credential.workspaceId
    this.pending.clear()
    this.requests.abort()
    this.requests = new AbortController()
    this.persist()
    this.updateSnapshot()
    await this.options.onChange?.()
    for (const listener of this.listeners) listener()
  }
  private active() { return this.activeId ? this.credentials.get(this.activeId) ?? null : null }
  getSnapshot = () => this.snapshot
  subscribe = (changed: () => void) => { this.listeners.add(changed); return () => { this.listeners.delete(changed) } }
  getServers(): WebServerEntry[] {
    return [...this.servers.values()].map(server => ({ ...server, signIn: { ...server.signIn }, active: (this.active()?.server ?? this.expiredServer) === server.url,
      accounts: [...this.credentials.values()].filter(account => account.server === server.url).map(safeSession) }))
  }
  getActiveAccount(): WebServerAccount | null { return this.snapshot.account }
  getVersion() { return this.generation }
  getWorkspaceVersion() { return this.workspaceGeneration }
  isCurrentResponse(response: Response) {
    const version = this.responseVersions.get(response)
    return version?.account === this.generation && version.workspace === this.workspaceGeneration
  }
  async readSession(): Promise<WebServerAccount | null> {
    const active = this.active()
    if (!active) return null
    const response = await this.fetch(`${active.server}/api/desktop/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mikka-desktop-protocol': '1' },
      body: JSON.stringify({ version: 1, action: 'desktop.session', args: [] }) })
    if (response.status === 401) return this.active() === active ? safeSession(active) : null
    if (!response.ok) throw new WebConnectionError('web_connection_session_unavailable')
    const value = await response.json() as { ok?: boolean; result?: DesktopSession }
    if (!value.ok || value.result?.user.id !== active.user.id || value.result?.session.id !== active.session.id) throw new WebConnectionError('web_connection_session_invalid')
    return safeSession(active)
  }
  /** Called by the original cookie SDK, never from remote response claims. */
  async rememberCloudAccounts(userIds: readonly string[]) {
    for (const id of userIds) if (validText(id)) this.cloudUsers.add(id)
    let collision = false
    for (const [key, account] of this.credentials) {
      if (!this.cloudUsers.has(account.user.id)) continue
      this.credentials.delete(key)
      if (this.activeId === key) {
        this.activeId = null
        this.expiredServer = account.server
      }
      collision = true
    }
    if (collision) await this.changed(); else this.persist()
  }
  async addServer(input: unknown): Promise<WebServerProbe> {
    const result = await probeWebServer(input, { fetch: this.options.fetch })
    if (result.status === 'ok') {
      if (result.server.url === this.app.href.replace(/\/$/, '')) throw new WebConnectionError('web_connection_cloud_selected')
      if (!this.servers.has(result.server.url) && this.servers.size >= 20) throw new WebConnectionError('web_connection_server_limit')
      this.servers.set(result.server.url, result.server); this.probed.set(result.server.url, this.now()); this.persist()
    }
    return result
  }
  async beginSignIn(serverUrl: string) {
    const version = this.generation
    const server = this.servers.get(serverUrl), probed = this.probed.get(serverUrl)
    if (!server || probed === undefined || this.now() - probed > 600_000) throw new WebConnectionError('web_connection_probe_required')
    const state = b64(crypto.getRandomValues(new Uint8Array(24))), verifier = b64(crypto.getRandomValues(new Uint8Array(32)))
    const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    const callback = `${this.app.href.replace(/\/$/, '')}/api/web/complete`
    const response = await this.options.fetch(`${server.url}/api/web/begin`, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state, challenge, callback }) })
    if (!response.ok) throw new WebConnectionError('web_connection_handoff_rejected')
    const value = await response.json() as { signInUrl?: unknown }
    const target = typeof value.signInUrl === 'string' ? new URL(value.signInUrl, server.url) : null
    if (!target || target.origin !== new URL(server.url).origin || target.pathname !== `${new URL(server.url).pathname.replace(/\/$/, '')}/sign-in`
      || target.username || target.password || target.hash) throw new WebConnectionError('web_connection_handoff_rejected')
    if (version !== this.generation) throw new WebConnectionError('web_connection_session_changed')
    this.pending.set(state, { state, verifier, callback, server, expiresAt: this.now() + 600_000, version })
    return { state, signInUrl: target.href }
  }
  async finishSignIn(input: { state: string; code: string }) {
    const pending = this.pending.get(input.state)
    this.pending.delete(input.state)
    if (!pending || pending.version !== this.generation || pending.expiresAt <= this.now() || !/^[A-Za-z0-9_-]{32,128}$/.test(input.code)) throw new WebConnectionError('web_connection_handoff_expired')
    const response = await this.options.fetch(`${pending.server.url}/api/web/exchange`, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: pending.state, code: input.code, verifier: pending.verifier, callback: pending.callback }) })
    if (!response.ok) throw new WebConnectionError('web_connection_handoff_rejected')
    const value = await response.json() as Record<string, unknown>
    const account = { token: value.token, user: value.user, session: value.session, server: pending.server.url }
    if (!this.validCredential(account, pending.server.url)) throw new WebConnectionError('web_connection_session_invalid')
    if (pending.version !== this.generation || !this.servers.has(account.server)) {
      await this.revoke(account).catch(() => {})
      throw new WebConnectionError('web_connection_session_changed')
    }
    if (this.conflicts(account.server, account.user.id)) {
      await this.revoke(account).catch(() => {})
      throw new WebConnectionError('web_connection_account_conflict')
    }
    this.credentials.set(this.key(account.server, account.user.id), account)
    this.activeId = this.key(account.server, account.user.id)
    this.expiredServer = null
    await this.changed()
    return safeSession(account)
  }
  async switchServer(serverUrl: string | null, userId?: string) {
    if (serverUrl === null) this.activeId = null
    else {
      const account = userId ? this.credentials.get(this.key(serverUrl, userId)) : [...this.credentials.values()].find(item => item.server === serverUrl)
      if (!account) throw new WebConnectionError('web_connection_sign_in_required')
      this.activeId = this.key(account.server, account.user.id)
    }
    this.expiredServer = null
    await this.changed()
  }
  private async revoke(account: Credential) {
    const response = await this.options.fetch(`${account.server}/api/web/revoke`, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { authorization: `Bearer ${account.token}` } })
    if (!response.ok && response.status !== 401) throw new WebConnectionError('web_connection_revoke_unconfirmed')
  }
  async signOut() {
    const account = this.active()
    this.expiredServer = null
    if (!account) { await this.changed(); return }
    this.credentials.delete(this.activeId!); this.activeId = null
    await this.changed()
    await this.revoke(account)
  }
  async disconnectServer(serverUrl: string) {
    const accounts = [...this.credentials.values()].filter(account => account.server === serverUrl)
    for (const account of accounts) this.credentials.delete(this.key(account.server, account.user.id))
    for (const [state, pending] of this.pending) if (pending.server.url === serverUrl) this.pending.delete(state)
    if (this.activeId && !this.credentials.has(this.activeId)) this.activeId = null
    if (this.expiredServer === serverUrl) this.expiredServer = null
    this.servers.delete(serverUrl); this.probed.delete(serverUrl)
    await this.changed()
    const results = await Promise.allSettled(accounts.map(account => this.revoke(account)))
    if (results.some(result => result.status === 'rejected')) throw new WebConnectionError('web_connection_revoke_unconfirmed')
  }
  /** Existing shared RPC/REST/upload/stream calls keep their API paths. Only
   * this selected account can supply the bearer; redirects always fail closed. */
  fetch: WebFetch = async (input, init) => {
    const account = this.active()
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, this.app)
    const localBase = this.app.pathname.replace(/\/$/, '')
    const localApi = url.origin === this.app.origin && url.pathname.startsWith(`${localBase}/api/`)
    // This checks the installed official renderer, not the selected backend's
    // independently released revision. Otherwise any self-hosted build would
    // permanently trigger the cloud page's required-refresh guard.
    if (localApi && url.pathname === `${localBase}/api/version`) {
      const source = new Request(input instanceof Request ? input : url, init), headers = new Headers(source.headers)
      for (const name of ['authorization', 'cookie', 'x-mikka-session-cache', 'x-mikka-session-token', 'x-deployment-id', WORKSPACE_SELECTION_HEADER]) headers.delete(name)
      return this.options.fetch(new Request(source, { headers, credentials: 'omit', redirect: 'error' }))
    }
    if (!account) {
      if (!localApi || url.pathname.startsWith(`${localBase}/api/auth/`)) return this.options.fetch(input, init)
      if (this.expiredServer) {
        const refusal = Response.json({ error: 'web_auth_session_expired' }, { status: 401, headers: { 'cache-control': 'no-store' } })
        this.responseVersions.set(refusal, { account: this.generation, workspace: this.workspaceGeneration })
        return refusal
      }
      const source = new Request(input instanceof Request ? input : url, init), version = this.generation, workspace = this.workspaceGeneration
      const response = await this.options.fetch(new Request(source, { signal: AbortSignal.any([source.signal, this.requests.signal]) }))
      if (version !== this.generation) { await response.body?.cancel(); throw new WebConnectionError('web_connection_session_changed') }
      this.responseVersions.set(response, { account: version, workspace })
      return response
    }
    const remote = new URL(account.server), remoteBase = remote.pathname.replace(/\/$/, '')
    const remoteApi = url.origin === remote.origin && url.pathname.startsWith(`${remoteBase}/api/`)
    if (!localApi && !remoteApi) return this.options.fetch(input, init)
    let path = url.pathname.slice(localApi ? localBase.length : remoteBase.length)
    // Better Auth's cookie SDK remains bound to the official origin. Remote
    // session reads/sign-out use the explicit web adapter, never cookie auth.
    if (path.startsWith('/api/auth/')) return this.options.fetch(input, init)
    if (path === '/api/rpc') path = '/api/desktop/rpc'
    const target = `${account.server}${path}${url.search}`
    if (new URL(target).origin !== remote.origin) throw new WebConnectionError('web_connection_origin_refused')
    const source = new Request(input instanceof Request ? input : url, init)
    const headers = new Headers(source.headers)
    for (const name of ['cookie', 'authorization', 'x-mikka-session-cache', 'x-mikka-session-token', 'x-deployment-id', 'x-mikka-rpc', WORKSPACE_SELECTION_HEADER]) headers.delete(name)
    // A late cloud tracing wrapper can decorate the official URL before this
    // adapter selects another origin. Its person/session IDs stay on the cloud.
    if (remote.origin !== this.app.origin) {
      for (const name of ['x-posthog-session-id', 'x-posthog-window-id', 'x-posthog-distinct-id']) headers.delete(name)
    }
    const requestToken = account.token
    headers.set('authorization', `Bearer ${requestToken}`)
    if (account.workspaceId) headers.set(WORKSPACE_SELECTION_HEADER, account.workspaceId)
    if (path === '/api/desktop/rpc') headers.set('x-mikka-desktop-protocol', '1')
    const version = this.generation, workspace = this.workspaceGeneration, sequence = ++this.requestSequence
    const selecting = path === '/api/desktop/rpc' && source.method === 'POST' ? await selectsWorkspace(source, path) : false
    if (version !== this.generation || workspace !== this.workspaceGeneration) throw new WebConnectionError('web_connection_session_changed')
    if (selecting) this.workspaceIntent = Math.max(this.workspaceIntent, sequence)
    const intent = selecting ? sequence : undefined
    if (intent !== undefined && intent !== this.workspaceIntent) throw new WebConnectionError('web_connection_session_changed')
    const signal = AbortSignal.any([source.signal, this.requests.signal])
    // A Request exposes its body as a stream. Forwarding that stream directly
    // makes Chromium require HTTP/2 even for a small JSON POST. Preserve the
    // original reusable body where possible and serialize prebuilt requests
    // and multipart data with the boundary from the normalized source.
    const supplied = init?.body
    const body = !source.body ? undefined
      : supplied != null && !(supplied instanceof ReadableStream) && !(supplied instanceof FormData)
        ? supplied : await source.blob()
    let response = await this.options.fetch(target, {
      method: source.method, headers, body, signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    })
    const current = () => version === this.generation && workspace === this.workspaceGeneration && (intent === undefined || intent === this.workspaceIntent)
    if (!current()) { await response.body?.cancel(); throw new WebConnectionError('web_connection_session_changed') }
    if (selecting && response.ok && response.headers.has(WORKSPACE_SELECTION_HEADER)) {
      const confirmed = response.headers.get(WORKSPACE_SELECTION_HEADER)!
      const workspaceId = confirmed === '' ? undefined : selectedWorkspaceId(confirmed)
      if (workspaceId === null) { await response.body?.cancel(); throw new WebConnectionError('web_connection_session_invalid') }
      if (workspaceId !== account.workspaceId) {
        // Keep this successful switch response readable while aborting every
        // older request/stream. A later selection intent always beats this one.
        const body = response.body ? await response.arrayBuffer() : null
        if (!current()) throw new WebConnectionError('web_connection_session_changed')
        response = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
        if (workspaceId === undefined) delete account.workspaceId
        else account.workspaceId = workspaceId
        this.workspaceGeneration++
        this.requests.abort()
        this.requests = new AbortController()
        this.persist()
        const acknowledged = this.workspaceGeneration
        // Retire the existing browser read/asset caches before any caller can
        // use the new choice; this is not an account or session replacement.
        await this.options.onChange?.()
        if (version !== this.generation || acknowledged !== this.workspaceGeneration || intent !== this.workspaceIntent) {
          throw new WebConnectionError('web_connection_session_changed')
        }
      }
    }
    if (account.token === requestToken) {
      const rotated = response.headers.get('x-mikka-session-token')
      if (response.status === 401) {
        this.credentials.delete(this.activeId!)
        this.activeId = null
        this.expiredServer = account.server
        await this.changed()
      } else if (response.ok && validSessionToken(rotated) && rotated !== requestToken) {
        account.token = rotated
        this.persist()
      }
    }
    this.responseVersions.set(response, { account: version, workspace: this.workspaceGeneration })
    return response
  }
}
