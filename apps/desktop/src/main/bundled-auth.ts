import { createHash, randomBytes } from 'node:crypto'
import type { BundledSession, BundledSignIn } from '@mikka/protocol/bridge'
import { remoteBase, safeAppNext } from './bundled-policy'
import { startBundledLoopback } from './bundled-loopback'
import type { LoopbackAuthServer } from './loopback'
import { publicSession, storedSession, type SessionVault, type StoredSession } from './session-vault'
import { accountChoice, responseWorkspace, rpcEnvelope } from './bundled-accounts'
import { openBundledWebPage } from './bundled-web'

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export class BundledAuth {
  private current: StoredSession | null = null
  private readonly saved = new Map<string, StoredSession>()
  private generation = 0
  private listener: LoopbackAuthServer | null = null
  private timeout: ReturnType<typeof setTimeout> | null = null
  private readonly base: URL
  constructor(private readonly options: {
    serverUrl: string; version: string; fetch: Fetcher; vault: SessionVault
    openExternal(url: string): Promise<void>; changed(): void; returned(next: string): void
    scopeChanged?(): void
  }) { this.base = remoteBase(options.serverUrl) }

  async restore(): Promise<void> {
    const stored = await this.options.vault.loadAccounts()
    this.saved.clear()
    for (const account of stored?.accounts ?? []) this.saved.set(account.identity.user.id, account)
    this.current = stored?.activeUserId ? this.saved.get(stored.activeUserId) ?? null : null
  }
  private persist(): Promise<void> {
    if (this.current) this.saved.set(this.current.identity.user.id, this.current)
    return this.options.vault.saveAccounts(this.saved.size ? { activeUserId: this.current?.identity.user.id ?? null, accounts: [...this.saved.values()] } : null)
  }
  private async commitAccount(account: StoredSession, generation: number): Promise<boolean> {
    const next = new Map(this.saved)
    next.set(account.identity.user.id, account)
    await this.options.vault.saveAccounts({ activeUserId: account.identity.user.id, accounts: [...next.values()] })
    if (generation !== this.generation) return false
    this.saved.clear()
    for (const [id, saved] of next) this.saved.set(id, saved)
    this.current = account
    return true
  }
  session(): BundledSession | null { return this.current ? structuredClone(this.current.identity) : null }
  /** Main-only authorization scope; neither token nor workspace selector crosses IPC. */
  scope(): string | null { return this.current ? JSON.stringify([this.current.identity.user.id, this.current.identity.session.id, this.current.workspace ?? null]) : null }
  private cancel(): void {
    this.listener?.close(); this.listener = null
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
  }
  dispose(): void { this.generation++; this.cancel() }

  /** Main-only primitive; a stored account chooses authentication, never an IPC token. */
  private async fetchAs(path: string, init: RequestInit, account: StoredSession | null): Promise<Response> {
    if (!path.startsWith('/api/') || path.includes('\\') || path.includes('#') || /%(?:2f|5c|2e|25)/i.test(path.split('?')[0]!)) throw new Error('Invalid backend path')
    const target = new URL(`${this.base.pathname.replace(/\/$/, '')}${path}`, this.base.origin)
    if (target.origin !== this.base.origin) throw new Error('Invalid backend origin')
    const headers = new Headers(init.headers)
    headers.delete('cookie'); headers.delete('authorization'); headers.delete('proxy-authorization')
    headers.set('origin', this.base.origin)
    headers.set('x-mikka-client', 'desktop')
    headers.set('x-mikka-client-version', this.options.version)
    headers.set('x-mikka-desktop-protocol', '1')
    const token = account?.token
    if (token) headers.set('authorization', `Bearer ${token}`)
    if (account?.workspace && !path.startsWith('/api/auth/')) headers.set('cookie', `mikka-workspace=${account.workspace}`)
    return this.options.fetch(target.href, { ...init, headers, credentials: 'omit', redirect: 'error', cache: 'no-store' })
  }

  /** Main-only primitive; callers supply known routes. Never accepts renderer credentials. */
  async request(path: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    const rpc = path === '/api/desktop/rpc' ? rpcEnvelope(init.body) : null
    const switchInput = rpc?.action === 'workspace.switchWorkspace' && rpc.args.length === 1 && rpc.args[0] && typeof rpc.args[0] === 'object' ? rpc.args[0] as { accountId?: unknown } : null
    if (authenticated && typeof switchInput?.accountId === 'string' && switchInput.accountId !== this.current?.identity.user.id) return this.switchAccount(path, init, switchInput.accountId, rpc?.version ?? 1)
    const token = authenticated ? this.current?.token : null
    const scope = authenticated ? this.scope() : null
    let response = await this.fetchAs(path, init, authenticated ? this.current : null)
    // A stale owner's failure must never sign out the newly selected account.
    // Successful stale data is rejected by the same boundary, including 401s.
    if (token && (token !== this.current?.token || scope !== this.scope())) return Response.json({ version: rpc?.version ?? 1, ok: false, error: { code: 'desktop_session_changed' } }, { status: 409 })
    if (token && this.current?.token === token) {
      // Workspace choice is not authentication. Only this exact, bounded selector
      // survives the response; all session cookies stay out of Chromium and IPC.
      const selected = responseWorkspace(response.headers)
      if (selected !== undefined) {
        const workspace = selected || undefined
        if (workspace !== this.current.workspace) {
          this.cancel(); this.generation++
          this.current = { ...this.current, workspace }
          this.options.scopeChanged?.()
          await this.persist()
        }
      }
    }
    if (response.status === 401 && token && this.current?.token === token) {
      this.saved.delete(this.current.identity.user.id)
      this.current = null
      await this.persist()
      this.options.changed()
    }
    // Password changes can rotate the current session. This private header is
    // never forwarded by the protocol and is accepted only for this exact RPC.
    const rotated = response.headers.get('x-mikka-session-token')
    if (response.ok && token && this.current?.token === token && rotated && rotated !== token && rpc) {
      const replacement = storedSession({ ...this.current, token: rotated })
      if (rpc.action === 'account.changePassword' && replacement) {
        this.cancel(); this.generation++
        this.current = replacement
        await this.persist()
        try {
          const refreshed = await this.request('/api/auth/get-session', { signal: AbortSignal.timeout(15_000) })
          const identity = refreshed.ok ? publicSession(await refreshed.json()) : null
          if (!identity) throw new Error('Session refresh failed')
          if (this.current?.token === rotated) { this.current = { ...this.current, identity }; await this.persist(); this.options.changed() }
        } catch {
          if (this.current?.token === rotated) { this.saved.delete(this.current.identity.user.id); this.current = null; await this.persist(); this.options.changed() }
        }
      }
    }
    if (response.ok && token && this.current?.token === token && path.split('?')[0] === '/api/workspace/switcher') response = await this.withSavedAccounts(response, init)
    return response
  }

  private async switchAccount(path: string, init: RequestInit, id: string, version: 0 | 1): Promise<Response> {
    const target = this.saved.get(id)
    if (!target) return Response.json({ version, ok: false, error: { code: 'desktop_rpc_request_rejected' } }, { status: 403 })
    const generation = this.generation
    const previous = this.current?.token
    const response = await this.fetchAs(path, init, target)
    if (response.status === 401) {
      if (this.saved.get(id)?.token === target.token) { this.saved.delete(id); await this.persist() }
      return Response.json({ version, ok: false, error: { code: 'desktop_rpc_request_rejected' } }, { status: 403 })
    }
    const body = response.ok ? await response.clone().json().catch(() => null) as { ok?: unknown; result?: { ok?: unknown } } | null : null
    if (body?.ok !== true || body.result?.ok !== true || generation !== this.generation || previous !== this.current?.token) return response
    const selected = responseWorkspace(response.headers)
    this.cancel()
    if (await this.commitAccount({ ...target, ...(selected !== undefined ? { workspace: selected ?? undefined } : {}) }, ++this.generation)) this.options.changed()
    return response
  }

  private async withSavedAccounts(response: Response, init: RequestInit): Promise<Response> {
    const current = this.current
    if (!current) return response
    const body: unknown = await response.clone().json().catch(() => null)
    const own = accountChoice(body, current.identity.user.id)
    if (!own || !body || typeof body !== 'object') return response
    const other = [...this.saved.values()].filter(item => item.identity.user.id !== current.identity.user.id)
    const results = await Promise.all(other.map(async account => {
      try {
        const result = await this.fetchAs('/api/workspace/switcher', { ...init, method: 'GET', body: undefined, signal: AbortSignal.timeout(15_000) }, account)
        if (!result.ok) return null
        return accountChoice(await result.json(), account.identity.user.id)
      } catch { return null }
    }))
    if (current.token !== this.current?.token) return Response.json({ error: 'desktop_session_changed' }, { status: 409 })
    return Response.json({ ...(body as Record<string, unknown>), accounts: [own, ...results.filter(item => item !== null)] }, { status: response.status, headers: { 'cache-control': 'no-store' } })
  }

  private async accept(value: unknown, generation: number): Promise<void> {
    const input = value as { token?: unknown }
    const identity = publicSession(value)
    const parsed = storedSession({ token: input?.token, identity })
    if (!parsed || generation !== this.generation) throw new Error('Sign-in expired / 登录已过期')
    // Same-account reauthentication replaces only that account; add-account
    // retains the other encrypted sessions, bounded like the web switcher.
    if (!this.saved.has(parsed.identity.user.id) && this.saved.size >= 5) throw new Error('desktop_account_limit_reached')
    if (!await this.commitAccount(parsed, generation)) return
    this.options.changed()
  }

  async signIn(input: unknown): Promise<void> {
    const value = (input ?? {}) as BundledSignIn
    if (typeof input !== 'object' || !input || (value.provider !== undefined && !['google', 'github'].includes(value.provider)) || (value.locale !== undefined && !['zh-CN', 'en'].includes(value.locale)) || (value.mode !== undefined && !['sign-in', 'sign-up'].includes(value.mode)) || (value.addAccount !== undefined && typeof value.addAccount !== 'boolean')) throw new Error('Invalid sign-in request / 登录请求无效')
    this.cancel()
    const generation = ++this.generation
    await this.options.vault.ensureAvailable()
    if (generation !== this.generation) return
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const next = safeAppNext(value.next)
    const listener = await startBundledLoopback(state, code => {
      if (generation !== this.generation) return
      this.cancel()
      void (async () => {
        const response = await this.request('/api/desktop/exchange', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state, code, verifier, client: 'bundled' }), signal: AbortSignal.timeout(30_000),
        }, false)
        if (!response.ok) throw new Error('Sign-in exchange failed')
        await this.accept(await response.json(), generation)
        if (generation === this.generation) this.options.returned(next)
      })().catch(() => { if (generation === this.generation) this.options.changed() })
    })
    if (generation !== this.generation) { listener.close(); return }
    this.listener = listener
    this.timeout = setTimeout(() => { if (generation === this.generation) this.cancel() }, 10 * 60_000)
    this.timeout.unref()
    try {
      const response = await this.request('/api/desktop/begin', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, callback: listener.callback, challenge }), signal: AbortSignal.timeout(15_000),
      }, false)
      if (!response.ok || generation !== this.generation) throw new Error('Sign-in registration failed / 登录登记失败')
      const route = `${this.base.pathname.replace(/\/$/, '')}${value.locale === 'en' ? '/en' : ''}/${value.mode === 'sign-up' ? 'sign-up' : 'sign-in'}`
      const url = new URL(route, this.base.origin)
      url.search = new URLSearchParams({ desktop: '1', desktop_state: state, desktop_next: next, desktop_callback: listener.callback }).toString()
      if (value.provider) url.searchParams.set('continue', value.provider)
      if (value.addAccount) url.searchParams.set('addAccount', '1')
      await this.options.openExternal(url.href)
    } catch (error) { if (generation === this.generation) this.cancel(); throw error }
  }

  async signInEmail(input: unknown): Promise<{ code?: string; status?: number } | null> {
    if (!input || typeof input !== 'object') return { code: 'INVALID_EMAIL_OR_PASSWORD', status: 400 }
    const { email, password } = input as { email?: unknown; password?: unknown }
    if (typeof email !== 'string' || email.length > 320 || !email.includes('@') || typeof password !== 'string' || password.length < 1 || password.length > 4096) return { code: 'INVALID_EMAIL_OR_PASSWORD', status: 400 }
    this.cancel()
    const generation = ++this.generation
    await this.options.vault.ensureAvailable()
    if (generation !== this.generation) return { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 }
    const response = await this.request('/api/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(30_000),
    }, false)
    const body = await response.json() as { token?: unknown; code?: unknown }
    if (!response.ok) return { code: typeof body.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(body.code) ? body.code : 'INVALID_EMAIL_OR_PASSWORD', status: response.status }
    if (typeof body.token !== 'string' || generation !== this.generation) return { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 }
    // Use the newly returned token only in main, before exposing public identity.
    const identityResponse = await this.options.fetch(new URL(`${this.base.pathname.replace(/\/$/, '')}/api/auth/get-session`, this.base.origin).href, {
      headers: { authorization: `Bearer ${body.token}`, origin: this.base.origin, 'x-mikka-client': 'desktop', 'x-mikka-client-version': this.options.version, 'x-mikka-desktop-protocol': '1' },
      redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15_000),
    })
    if (!identityResponse.ok) return { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 }
    const identity = publicSession(await identityResponse.json())
    await this.accept({ ...identity, token: body.token }, generation)
    return null
  }

  async signOut(): Promise<void> {
    this.generation++; this.cancel()
    const revocation = Promise.all([...this.saved.values()].map(account => this.fetchAs('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) }, account).catch(() => null)))
    this.current = null
    this.saved.clear()
    await this.persist()
    this.options.changed()
    await revocation
  }
  async accounts(): Promise<{ providerId: string }[]> {
    if (!this.current) return []
    const response = await this.request('/api/auth/list-accounts', { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return []
    const value: unknown = await response.json()
    return Array.isArray(value) ? value.flatMap(item => item && typeof item === 'object' && typeof item.providerId === 'string' ? [{ providerId: item.providerId.slice(0, 100) }] : []) : []
  }
  async linkAccount(provider: unknown): Promise<void> {
    if (provider !== 'google' && provider !== 'github') throw new Error('Invalid account provider')
    if (!this.current) throw new Error('Sign in first / 请先登录')
    // Linking requires the browser's explicit authenticated account confirmation.
    const url = new URL(`${this.base.pathname.replace(/\/$/, '')}/?settings=account`, this.base.origin)
    if (!await openBundledWebPage(url.href, { serverUrl: this.options.serverUrl, auth: this, openExternal: this.options.openExternal })) throw new Error('Invalid account link target')
  }
}
