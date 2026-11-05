import { createHash, randomBytes } from 'node:crypto'
import type { BundledSession, BundledSignIn } from '@mikka/protocol/bridge'
import { remoteBase, safeAppNext } from './bundled-policy'
import { startBundledLoopback } from './bundled-loopback'
import type { LoopbackAuthServer } from './loopback'
import { publicSession, storedSession, WORKSPACE_ID, type SessionVault, type StoredSession } from './session-vault'

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export class BundledAuth {
  private current: StoredSession | null = null
  private generation = 0
  private listener: LoopbackAuthServer | null = null
  private timeout: ReturnType<typeof setTimeout> | null = null
  private readonly base: URL
  constructor(private readonly options: {
    serverUrl: string; version: string; fetch: Fetcher; vault: SessionVault
    openExternal(url: string): Promise<void>; changed(): void; returned(next: string): void
  }) { this.base = remoteBase(options.serverUrl) }

  async restore(): Promise<void> { this.current = await this.options.vault.load() }
  session(): BundledSession | null { return this.current ? structuredClone(this.current.identity) : null }
  private cancel(): void {
    this.listener?.close(); this.listener = null
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
  }
  dispose(): void { this.generation++; this.cancel() }

  /** Main-only primitive; callers supply known routes. Never accepts renderer headers. */
  async request(path: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    if (!path.startsWith('/api/') || path.includes('\\') || path.includes('#') || /%(?:2f|5c|2e|25)/i.test(path.split('?')[0]!)) throw new Error('Invalid backend path')
    const target = new URL(`${this.base.pathname.replace(/\/$/, '')}${path}`, this.base.origin)
    if (target.origin !== this.base.origin) throw new Error('Invalid backend origin')
    const headers = new Headers(init.headers)
    headers.delete('cookie'); headers.delete('authorization'); headers.delete('proxy-authorization')
    headers.set('origin', this.base.origin)
    headers.set('x-mikka-client', 'desktop')
    headers.set('x-mikka-client-version', this.options.version)
    headers.set('x-mikka-desktop-protocol', '1')
    const token = authenticated ? this.current?.token : null
    if (token) headers.set('authorization', `Bearer ${token}`)
    if (token && this.current?.workspace) headers.set('cookie', `mikka-workspace=${this.current.workspace}`)
    const response = await this.options.fetch(target.href, { ...init, headers, credentials: 'omit', redirect: 'error', cache: 'no-store' })
    if (token && this.current?.token === token) {
      // Workspace choice is not authentication. Only this exact, bounded selector
      // survives the response; all session cookies stay out of Chromium and IPC.
      const raw = response.headers.get('set-cookie') ?? ''
      const selected = /(?:^|,\s*)mikka-workspace=([^;,]*)/.exec(raw)?.[1]
      if (selected !== undefined && (selected === '' || WORKSPACE_ID.test(selected))) {
        const workspace = selected || undefined
        if (workspace !== this.current.workspace) {
          this.current = { ...this.current, workspace }
          await this.options.vault.save(this.current)
        }
      }
    }
    if (response.status === 401 && token && this.current?.token === token) {
      this.current = null
      await this.options.vault.save(null)
      this.options.changed()
    }
    return response
  }

  private async accept(value: unknown, generation: number): Promise<void> {
    const input = value as { token?: unknown }
    const identity = publicSession(value)
    const parsed = storedSession({ token: input?.token, identity })
    if (!parsed || generation !== this.generation) throw new Error('Sign-in expired / 登录已过期')
    await this.options.vault.save(parsed)
    if (generation !== this.generation) return
    this.current = parsed
    this.options.changed()
  }

  async signIn(input: unknown): Promise<void> {
    const value = (input ?? {}) as BundledSignIn
    if (typeof input !== 'object' || !input || (value.provider !== undefined && !['google', 'github'].includes(value.provider)) || (value.locale !== undefined && !['zh-CN', 'en'].includes(value.locale)) || (value.mode !== undefined && !['sign-in', 'sign-up'].includes(value.mode)) || (value.addAccount !== undefined && typeof value.addAccount !== 'boolean')) throw new Error('Invalid sign-in request / 登录请求无效')
    this.cancel()
    const generation = ++this.generation
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
    const revocation = this.current ? this.request('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) }).catch(() => null) : Promise.resolve(null)
    this.current = null
    await this.options.vault.save(null)
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
    await this.options.openExternal(url.href)
  }
}
