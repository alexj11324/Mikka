import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Page, type ElementHandle } from 'playwright-core'
import { CredentialError, type Binding, type BrowserTaskAction } from './contracts'
import { assertBrowserIsolationTransition, type BrowserIsolationPhase } from './browser-protocol'

export type OwnedBrowserPolicy = {
  id: string; formURL: string; submitURL: string; successURL: string
  secretSelector: string; submitSelector: string; verifiedSelector: string
  continuation?: { accountURL: string; accountSelector: string; cookieName: string; pages?: OwnedTaskPage[] }
}
export type OwnedTaskPage = { id: string; url: string; regions: { id: string; selector: string }[]; links?: { id: string; selector: string; pageId: string }[] }
export type AcceptanceProfile = Readonly<{ id: string; directory: string; profile: string; artifacts: string }>
export type AcceptanceCleanupStage = 'launch-blocked' | 'launch-failed' | 'setup-failed' | 'destroy'
// Trusted synthetic Linux fixture observation only; never receives browser/page
// handles and cannot authorize disposal. All cleanup with this hook stays pending.
export type AcceptanceResources = {
  prepareProfile(): Promise<AcceptanceProfile>
  started(profile: AcceptanceProfile): Promise<void>
  beforeCleanup(profile: AcceptanceProfile, stage: AcceptanceCleanupStage): Promise<void>
  recordFailure?(profile: AcceptanceProfile, stage: 'launch-failed' | 'setup-failed', cause: unknown): Promise<void>
}
// Shared by the real launch call and prepare-only validation; ordinary launches
// retain their existing options. Acceptance artifacts never use host os.tmpdir().
export function acceptanceArtifactOptions(profile?: AcceptanceProfile) {
  if (!profile) return {}
  if (!isAbsolute(profile.directory) || profile.profile !== join(profile.directory, 'profile') || profile.artifacts !== join(profile.directory, 'artifacts')) {
    throw new CredentialError('browser_acceptance_profile_invalid', 503)
  }
  return { artifactsDir: profile.artifacts, downloadsPath: profile.artifacts, tracesDir: profile.artifacts }
}
// Playwright owns additional failure/exit cleanup outside this executor. Until
// that lifecycle has separately approved control, acceptance is setup-only.
export async function guardAcceptanceLaunch(resources?: AcceptanceResources, profile?: AcceptanceProfile): Promise<void> {
  if (!resources) return
  if (!profile) throw new CredentialError('browser_acceptance_profile_missing', 503)
  acceptanceArtifactOptions(profile)
  await resources.beforeCleanup(profile, 'launch-blocked')
  throw new CredentialError('browser_acceptance_setup_only', 503)
}
export async function rejectAcceptanceDisposal(resources: AcceptanceResources, profile: AcceptanceProfile, stage: 'launch-failed' | 'setup-failed' | 'destroy'): Promise<never> {
  await resources.beforeCleanup(profile, stage)
  throw new CredentialError('browser_acceptance_disposal_pending', 503)
}
type Session = {
  binding: Binding; browser: Browser; context: BrowserContext; page: Page; directory: string
  contextIdentity: string
  fenced: boolean; phase: BrowserIsolationPhase | 'idle'; active: Set<Promise<unknown>>
  authenticated?: { reference: string; serviceId: string; expiresAt: number; sensitiveHashes: string[]; sensitiveLengths: number[] }
  destroying?: Promise<void>
  expiryTimer?: ReturnType<typeof setTimeout>
  endedReference?: string; revoked?: boolean; executing: boolean
  permittedNavigation?: string
  acceptanceProfile?: AcceptanceProfile
}
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CredentialError('browser_deadline_exceeded', 503)), milliseconds) })])
  } finally { if (timer) clearTimeout(timer) }
}
export type OwnedBrowserResult = {
  result: 'site_policy_verified' | 'submitted_unverified'
  cleanup: 'isolated_context_destroyed' | 'password_context_destroyed_auth_retained'; phase: 'restored'
  sessionExpiresAt?: string
}

function sameBinding(a: Binding, b: Binding) {
  return a.ownerId === b.ownerId && a.authSessionId === b.authSessionId && a.workspaceId === b.workspaceId &&
    a.taskId === b.taskId && a.runId === b.runId && a.executionSession === b.executionSession
}

/** A new browser owned solely by the trusted backend. No attach/connect/CDP URL,
 * persistent profile, shared browser or raw Page/Browser handle API exists.
 * Untrusted shell/process access to this backend host is outside this boundary:
 * run it apart from daemon agent sandboxes. The shared CUA browser remains unsupported.
 */
export class OwnedChromiumExecutor {
  #sessions = new Map<string, Session>()
  #policies = new Map<string, Readonly<OwnedBrowserPolicy>>()
  #events: { session: string; phase: string }[] = []
  #acceptanceResources?: AcceptanceResources
  describe(serviceId: string) {
    const policy = this.#policies.get(serviceId)
    return policy ? { serviceId, targetOrigin: new URL(policy.formURL).origin } : undefined
  }

  async prepare(binding: Binding, serviceId: string) {
    if (!this.#policies.has(serviceId)) return undefined
    if (!this.#sessions.has(binding.executionSession)) await this.open(binding)
    return this.policy(serviceId, binding)
  }

  claim(binding: Binding, reference: string) {
    const session = this.#session(binding)
    if (session.fenced || session.authenticated || (session.endedReference && session.endedReference !== reference)) throw new CredentialError('browser_isolation_locked', 423)
    session.endedReference = reference
  }
  constructor(private readonly config: {
    executablePath: string; policies: OwnedBrowserPolicy[];
    // Only for synthetic loopback acceptance in this cloud Linux environment.
    loopbackFixture?: boolean
    acceptanceResources?: AcceptanceResources
    sessionTTLms?: number
  }) {
    if (config.acceptanceResources) {
      if (config.loopbackFixture !== true || process.platform !== 'linux') throw new CredentialError('browser_acceptance_resources_forbidden', 503)
      const resources = config.acceptanceResources
      this.#acceptanceResources = Object.freeze({ prepareProfile: resources.prepareProfile.bind(resources), started: resources.started.bind(resources), beforeCleanup: resources.beforeCleanup.bind(resources), recordFailure: resources.recordFailure?.bind(resources) })
    }
    if (process.env.PWDEBUG || /pw:|playwright/i.test(process.env.DEBUG ?? '')) throw new CredentialError('browser_debug_capture_forbidden', 503)
    if (config.sessionTTLms !== undefined && (!Number.isInteger(config.sessionTTLms) || config.sessionTTLms < 250 || config.sessionTTLms > 300_000)) throw new CredentialError('browser_policy_invalid', 503)
    for (const policy of config.policies) {
      const urls = [policy.formURL, policy.submitURL, policy.successURL, ...(policy.continuation ? [policy.continuation.accountURL, ...(policy.continuation.pages ?? []).map(page => page.url)] : [])].map(s => new URL(s))
      if (this.#policies.has(policy.id) || !/^[a-z][a-z0-9_-]{0,63}$/.test(policy.id) ||
        urls.some(u => u.origin !== urls[0].origin || u.username || u.password || u.search || u.hash ||
          (config.loopbackFixture ? u.protocol !== 'http:' || u.hostname !== '127.0.0.1' : u.protocol !== 'https:')) ||
        !policy.secretSelector || !policy.submitSelector || !policy.verifiedSelector ||
        (policy.continuation && (!policy.continuation.accountSelector || !/^[a-zA-Z0-9_-]{1,64}$/.test(policy.continuation.cookieName)))) throw new CredentialError('browser_policy_invalid', 503)
      const pages = policy.continuation?.pages
      if (pages && (!pages.length || pages.length > 20 || new Set(pages.map(p => p.id)).size !== pages.length ||
        !pages.some(p => p.id === 'account' && p.url === policy.continuation!.accountURL) || pages.some(p =>
          !/^[a-z][a-z0-9_-]{0,63}$/.test(p.id) || [policy.formURL, policy.submitURL].includes(p.url) || !p.regions.length ||
          p.regions.some(r => !/^[a-z][a-z0-9_-]{0,63}$/.test(r.id) || !r.selector) ||
          p.links?.some(link => !/^[a-z][a-z0-9_-]{0,63}$/.test(link.id) || !link.selector || !pages.some(target => target.id === link.pageId))))) throw new CredentialError('browser_policy_invalid', 503)
      this.#policies.set(policy.id, Object.freeze(JSON.parse(JSON.stringify(policy))))
    }
  }

  policy(serviceId: string, binding: Binding) {
    const session = this.#sessions.get(binding.executionSession)
    const policy = this.#policies.get(serviceId)
    if (!session || !sameBinding(session.binding, binding) || session.fenced || session.authenticated || session.phase === 'quarantined' || !policy) return undefined
    return { origin: new URL(policy.formURL).origin, fingerprint: createHash('sha256').update(JSON.stringify([policy, session.contextIdentity])).digest('hex') }
  }

  async #launch(binding: Binding): Promise<Session> {
    const prepared = await this.#acceptanceResources?.prepareProfile()
    const acceptanceProfile = prepared ? Object.freeze({ ...prepared }) : undefined
    await guardAcceptanceLaunch(this.#acceptanceResources, acceptanceProfile)
    const directory = acceptanceProfile?.directory ?? await mkdtemp(join(tmpdir(), 'mikka-credential-browser-'))
    try {
      // An anonymous debugging pipe, never a listening CDP port. The profile is fresh,
      // private and destroyed with the process; it is never attached to or reused.
      const context = await chromium.launchPersistentContext(acceptanceProfile?.profile ?? join(directory, 'profile'), {
        executablePath: this.config.executablePath, headless: true,
        timeout: 5000,
        // Explicit host-side path: browser env TMPDIR alone does not contain Playwright artifacts.
        ...acceptanceArtifactOptions(acceptanceProfile),
        acceptDownloads: false, serviceWorkers: 'block', javaScriptEnabled: false,
        chromiumSandbox: !this.config.loopbackFixture,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'C.UTF-8' },
        args: ['--disable-extensions', '--disable-sync', '--disable-save-password-bubble', '--disable-breakpad'],
      })
      const browser = context.browser()!
      try {
        if (acceptanceProfile) await this.#acceptanceResources!.started(acceptanceProfile)
        await context.routeWebSocket('**', socket => socket.close())
        const page = context.pages()[0] ?? await context.newPage()
        page.setDefaultTimeout(1000)
        const session: Session = { binding: { ...binding }, browser, context, page, directory, acceptanceProfile, contextIdentity: randomUUID(), fenced: false, phase: 'idle', active: new Set(), executing: false }
        context.on('page', other => {
          if (other === page) return
          if (acceptanceProfile) { session.fenced = true; session.revoked = true; return }
          void other.close().catch(() => {})
        })
        return session
      } catch (cause) {
        if (acceptanceProfile) await this.#acceptanceResources!.recordFailure?.(acceptanceProfile, 'setup-failed', cause)
        if (acceptanceProfile) await this.#retainAcceptance(acceptanceProfile, 'setup-failed')
        await browser.close(); throw new Error()
      }
    } catch (cause) {
      if (acceptanceProfile) await this.#acceptanceResources!.recordFailure?.(acceptanceProfile, 'launch-failed', cause)
      if (acceptanceProfile) await this.#retainAcceptance(acceptanceProfile, 'launch-failed')
      await rm(directory, { recursive: true, force: true })
      throw new CredentialError('browser_launch_unavailable', 503)
    }
  }

  async #retainAcceptance(profile: AcceptanceProfile, stage: 'launch-failed' | 'setup-failed' | 'destroy'): Promise<never> {
    return rejectAcceptanceDisposal(this.#acceptanceResources!, profile, stage)
  }

  /** Trusted executor provisioning only. This starts a fresh blank process, never an agent browser. */
  async open(binding: Binding) {
    if (this.#sessions.has(binding.executionSession)) throw new CredentialError('browser_session_exists', 409)
    const session = await this.#launch(binding)
    if (this.#sessions.has(binding.executionSession)) { await this.#destroy(session); throw new CredentialError('browser_session_exists', 409) }
    this.#sessions.set(binding.executionSession, session)
    session.expiryTimer = setTimeout(() => { void this.end(binding).catch(() => {}) }, 300_000)
    session.expiryTimer.unref()
  }

  #session(binding: Binding) {
    const session = this.#sessions.get(binding.executionSession)
    if (!session || !sameBinding(session.binding, binding)) throw new CredentialError('browser_session_not_found', 404)
    return session
  }
  #move(session: Session, phase: BrowserIsolationPhase) {
    if (session.phase !== 'idle') assertBrowserIsolationTransition(session.phase, phase)
    session.phase = phase
    this.#events.push({ session: session.binding.executionSession, phase })
  }

  async #access<T>(binding: Binding, callback: (page: Page) => Promise<T>) {
    const session = this.#session(binding)
    if (session.fenced || session.phase === 'quarantined') throw new CredentialError('browser_isolation_locked', 423)
    // Retained authentication permits only the named projection through the broker.
    // Raw DOM/pixels/clicks can expose session tokens in arbitrary account pages.
    if (session.authenticated) throw new CredentialError('browser_restricted_session', 403)
    const operation = callback(session.page)
    session.active.add(operation)
    try { return await operation }
    finally { session.active.delete(operation) }
  }
  readDOM(binding: Binding) { return this.#access(binding, page => page.content()) }
  screenshot(binding: Binding) { return this.#access(binding, page => page.screenshot({ timeout: 1000 })) }
  click(binding: Binding, selector: string) { return this.#access(binding, page => page.locator(selector).click({ timeout: 1000 })) }
  // Raw CDP and recording are never agent-facing capabilities, including outside isolation.
  rawCDP(_binding: Binding): never { throw new CredentialError('browser_raw_access_forbidden', 423) }
  record(_binding: Binding): never { throw new CredentialError('browser_raw_access_forbidden', 423) }
  state(binding: Binding) { const s = this.#session(binding); return { phase: s.phase, fenced: s.fenced } }
  events() { return this.#events.map(event => ({ ...event })) }

  async #destroy(session: Session) {
    if (session.expiryTimer) clearTimeout(session.expiryTimer)
    // TTL, cancellation and an in-flight action may all request destruction.
    // Join the same attempt; a failed attempt remains fenced and may be retried.
    if (session.destroying) return session.destroying
    const attempt = (async () => {
      if (session.acceptanceProfile) {
        session.fenced = true
        await this.#retainAcceptance(session.acceptanceProfile, 'destroy')
      }
      await bounded(session.browser.close(), 5000)
      await rm(session.directory, { recursive: true, force: true })
    })()
    session.destroying = attempt
    try { await attempt }
    finally { if (session.destroying === attempt) session.destroying = undefined }
  }

  async #routes(session: Session, allowed: Set<string>, getOnly = false) {
    await session.context.route('**/*', async route => {
      if (allowed.has(route.request().url()) && (!getOnly || (route.request().method() === 'GET' && route.request().isNavigationRequest() && route.request().frame() === session.page.mainFrame() && route.request().url() === session.permittedNavigation))) await route.continue()
      else await route.abort('blockedbyclient')
    })
  }

  async #navigate(session: Session, url: string, click?: () => Promise<void>) {
    session.permittedNavigation = url
    try {
      if (click) await Promise.all([session.page.waitForURL(url, { waitUntil: 'domcontentloaded', timeout: 3000 }), click()])
      else await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 3000 })
    } finally { session.permittedNavigation = undefined }
  }

  #redact(text: string, session: Session) {
    const authentication = session.authenticated!
    const byLength = new Map<number, Set<string>>()
    authentication.sensitiveHashes.forEach((hash, index) => {
      const length = authentication.sensitiveLengths[index]
      if (!length || length > text.length) return
      if (!byLength.has(length)) byLength.set(length, new Set())
      byLength.get(length)!.add(hash)
    })
    const matches: [number, number][] = []
    for (const [length, hashes] of byLength) {
      for (let cursor = 0; cursor + length <= text.length; cursor++) {
        if (hashes.has(createHash('sha256').update(text.slice(cursor, cursor + length)).digest('hex'))) matches.push([cursor, cursor + length])
      }
    }
    matches.sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = []
    for (const interval of matches) {
      const previous = merged.at(-1)
      if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1])
      else merged.push([...interval])
    }
    let result = '', cursor = 0
    for (const [start, end] of merged) { result += text.slice(cursor, start) + '[REDACTED]'; cursor = end }
    return (result + text.slice(cursor)).slice(0, 4096)
  }

  async #refreshRedactions(session: Session, allowFenced = false) {
    const cookies = await session.context.cookies()
    const authentication = session.authenticated
    if (!authentication || (!allowFenced && session.fenced)) throw new CredentialError('credential_request_gone', 410)
    for (const cookie of cookies) {
      if (!cookie.value) continue
      const hash = createHash('sha256').update(cookie.value).digest('hex')
      if (authentication.sensitiveHashes.includes(hash)) continue
      if (authentication.sensitiveHashes.length >= 128) throw new CredentialError('browser_redaction_limit', 502)
      authentication.sensitiveHashes.push(hash); authentication.sensitiveLengths.push(cookie.value.length)
    }
  }

  async #projection(session: Session, policy: Readonly<OwnedBrowserPolicy>) {
    if (!policy.continuation || !session.authenticated) throw new CredentialError('browser_not_authenticated', 401)
    await this.#navigate(session, policy.continuation.accountURL)
    if (session.page.url() !== policy.continuation.accountURL || !await session.page.locator(policy.verifiedSelector).isVisible()) throw new CredentialError('browser_verification_failed', 502)
    await this.#refreshRedactions(session, true)
    const accountId = (await session.page.locator(policy.continuation.accountSelector).textContent())?.trim() ?? ''
    // Fixed non-sensitive identifier grammar; never return DOM, cookies, URLs or arbitrary page text.
    if (!/^[A-Z][A-Z0-9_]{1,31}-[0-9]{1,16}$/.test(accountId) || session.authenticated.sensitiveHashes.includes(createHash('sha256').update(accountId).digest('hex'))) throw new CredentialError('browser_projection_rejected', 502)
    return { accountId }
  }

  /** Only the broker exposes this fixed read to the authenticated task. */
  async readProtected(binding: Binding, serviceId: string, reference: string, authorized: () => Promise<boolean>) {
    return this.#authenticatedOperation(binding, serviceId, reference, authorized, session => this.#projection(session, this.#policies.get(serviceId)!))
  }

  async taskAction(binding: Binding, serviceId: string, reference: string, action: BrowserTaskAction, authorized: () => Promise<boolean>) {
    return this.#authenticatedOperation(binding, serviceId, reference, authorized, async session => {
      const policy = this.#policies.get(serviceId)!
      const pages = policy.continuation!.pages ?? [{ id: 'account', url: policy.continuation!.accountURL, regions: [{ id: 'account-id', selector: policy.continuation!.accountSelector }] }]
      let page = pages.find(candidate => candidate.url === session.page.url())
      if (action.type === 'navigate') {
        page = pages.find(candidate => candidate.id === action.pageId)
        if (!page) throw new CredentialError('browser_action_not_allowed', 400)
        await this.#navigate(session, page.url)
      } else if (action.type === 'click') {
        const link = page?.links?.find(candidate => candidate.id === action.targetId)
        const destination = pages.find(candidate => candidate.id === link?.pageId)
        if (!link || !destination) throw new CredentialError('browser_action_not_allowed', 400)
        const node = session.page.locator(link.selector)
        const validLink = await node.evaluate((element, target) => element.tagName === 'A' && !element.closest('form') && (element as HTMLAnchorElement).href === target, destination.url)
        if (!validLink) throw new CredentialError('browser_action_not_allowed', 400)
        await this.#navigate(session, destination.url, () => node.click())
        page = destination
      }
      if (!page || session.page.url() !== page.url || !await session.page.locator(policy.verifiedSelector).isVisible()) throw new CredentialError('browser_verification_failed', 502)
      await this.#refreshRedactions(session)
      if (action.type !== 'read') return { pageId: page.id }
      const region = page.regions.find(candidate => candidate.id === action.regionId)
      if (!region) throw new CredentialError('browser_action_not_allowed', 400)
      const lookahead = 4096 + Math.max(...session.authenticated!.sensitiveLengths) - 1
      const text = await session.page.locator(region.selector).evaluate((element, limit) => {
        if (element.matches('input,textarea,select,script,style,template,[data-sensitive],[contenteditable]')) return '[REDACTED]'
        const clone = element.cloneNode(true) as HTMLElement
        clone.querySelectorAll('input,textarea,select,script,style,template,[data-sensitive],[contenteditable]').forEach(node => node.remove())
        return clone.textContent?.slice(0, limit) ?? ''
      }, lookahead)
      return { pageId: page.id, text: this.#redact(text, session) }
    })
  }

  async #authenticatedOperation<T>(binding: Binding, serviceId: string, reference: string, authorized: () => Promise<boolean>, action: (session: Session) => Promise<T>) {
    const session = this.#session(binding), policy = this.#policies.get(serviceId)
    if (session.fenced) throw new CredentialError('browser_isolation_locked', 423)
    if (!session.authenticated || session.authenticated.reference !== reference || session.authenticated.serviceId !== serviceId || !policy?.continuation) throw new CredentialError('browser_not_authenticated', 401)
    if (session.active.size) throw new CredentialError('browser_busy', 409)
    const check = async () => {
      const valid = await authorized()
      if (session.fenced || !session.authenticated || Date.now() >= session.authenticated.expiresAt || !valid) throw new CredentialError('credential_request_gone', 410)
    }
    const operation = (async () => {
      try {
        await check()
        const result = await action(session)
        await check()
        return result
      } catch (error) {
        await this.end(binding, reference)
        throw error instanceof CredentialError ? error : new CredentialError('browser_execution_failed', 502)
      }
    })()
    session.active.add(operation)
    try { return await operation }
    finally { session.active.delete(operation) }
  }

  /** Task completion/cancel/disconnect/TTL: fence synchronously before asynchronous destruction. */
  async end(binding: Binding, reference?: string) {
    const session = this.#sessions.get(binding.executionSession)
    if (!session) return
    if (reference && (session.authenticated?.reference ?? session.endedReference) !== reference) return
    if (!sameBinding(session.binding, binding)) throw new CredentialError('browser_session_not_found', 404)
    session.fenced = true
    session.revoked = true
    session.endedReference = session.authenticated?.reference ?? session.endedReference
    session.authenticated = undefined
    try {
      await this.#destroy(session)
      if (!session.executing && this.#sessions.get(binding.executionSession) === session) this.#sessions.delete(binding.executionSession)
      this.#events.push({ session: binding.executionSession, phase: 'closed' })
    } catch (error) {
      if (!session.executing) session.phase = 'quarantined'
      this.#events.push({ session: binding.executionSession, phase: 'quarantined' })
      if (session.acceptanceProfile && error instanceof CredentialError && error.code === 'browser_acceptance_disposal_pending') throw error
      throw new CredentialError('browser_cleanup_quarantined', 503)
    }
  }

  async #discardReplacement(replacement: Session, original: Session, reference: string) {
    try { await this.#destroy(replacement) }
    catch {
      replacement.fenced = true; replacement.revoked = true; replacement.phase = 'quarantined'
      replacement.endedReference = reference; replacement.authenticated = undefined
      if (this.#sessions.get(original.binding.executionSession) === original) this.#sessions.set(original.binding.executionSession, replacement)
      throw new CredentialError('browser_cleanup_quarantined', 503)
    }
  }

  async #restore(session: Session, policy: Readonly<OwnedBrowserPolicy>, binding: Binding, serviceId: string,
    reference: string, success: boolean, passwordHash: string | undefined, passwordLength: number, sessionDeadline: number, check: () => Promise<void>) {
    if (session.revoked) { await this.#destroy(session); throw new CredentialError('credential_request_gone', 410) }
    // Only the selected HttpOnly cookie moves internally; no model-visible token, cookie API or file.
    const cookies = success && policy.continuation ? (await session.context.cookies(policy.successURL)).filter(cookie => cookie.name === policy.continuation!.cookieName) : []
    if (success && policy.continuation && (cookies.length !== 1 || !cookies[0].httpOnly || !cookies[0].value || cookies[0].value.length > 4096 || createHash('sha256').update(cookies[0].value).digest('hex') === passwordHash)) throw new CredentialError('browser_session_cookie_rejected', 502)
    await this.#destroy(session)
    const replacement = await this.#launch(binding)
    replacement.contextIdentity = session.contextIdentity
    replacement.fenced = true; replacement.endedReference = reference
    try {
      if (success && policy.continuation) {
        replacement.authenticated = { reference, serviceId, expiresAt: Math.min(sessionDeadline, Date.now() + Math.max(250, Math.min(300_000, this.config.sessionTTLms ?? 300_000))), sensitiveHashes: [passwordHash!, createHash('sha256').update(cookies[0].value).digest('hex')], sensitiveLengths: [passwordLength, cookies[0].value.length] }
        await replacement.context.addCookies(cookies)
        await this.#routes(replacement, new Set([policy.continuation.accountURL, ...(policy.continuation.pages ?? []).map(page => page.url)]), true)
        await this.#projection(replacement, policy)
        // Original form/POST history/password process are gone. Clear all fresh-page input values.
        await replacement.page.locator('input, textarea').evaluateAll(elements => elements.forEach(element => { (element as HTMLInputElement).value = ''; element.removeAttribute('value') }))
        await check()
      }
      if (!replacement.authenticated) replacement.endedReference = undefined
      return replacement
    } catch (error) { await this.#discardReplacement(replacement, session, reference); throw error }
  }

  async #install(original: Session, replacement: Session, reference: string) {
    if (original.revoked || this.#sessions.get(original.binding.executionSession) !== original) {
      await this.#discardReplacement(replacement, original, reference)
      throw new CredentialError('credential_request_gone', 410)
    }
    this.#move(original, 'restored')
    replacement.phase = 'restored'; replacement.fenced = false
    this.#sessions.set(original.binding.executionSession, replacement)
    if (replacement.authenticated) {
      replacement.expiryTimer = setTimeout(() => { void this.end(original.binding, reference).catch(() => {}) }, Math.max(1, replacement.authenticated.expiresAt - Date.now()))
      replacement.expiryTimer.unref()
    }
  }

  async execute(binding: Binding, serviceId: string, capability: {
    requestId: string
    sessionDeadline: number
    // This closure lives in the broker, resolves an opaque reference only after isolation,
    // and admits use atomically after the read. No plaintext RPC/tool argument is involved.
    resolveAndAdmit: () => Promise<string>
    stillAuthorized: () => Promise<boolean>
  }): Promise<OwnedBrowserResult> {
    const session = this.#session(binding), policy = this.#policies.get(serviceId)
    if (!policy || !this.policy(serviceId, binding)) throw new CredentialError('browser_policy_unavailable', 501)
    if (!Number.isFinite(capability.sessionDeadline) || capability.sessionDeadline <= Date.now()) throw new CredentialError('credential_request_gone', 410)
    if (session.fenced) throw new CredentialError('browser_isolation_locked', 423)
    session.fenced = true // Synchronous fence before any awaited operation: applies to all callers/agents.
    session.executing = true; session.endedReference = capability.requestId
    session.phase = 'reserved'; this.#move(session, 'draining')
    let secret: string | undefined
    let passwordHash: string | undefined
    let passwordLength = 0
    let success = false
    let failure: CredentialError | undefined
    let retained: Session | undefined
    let retainedExpiresAt: string | undefined
    const deadline = Date.now() + 15_000
    const check = async () => {
      if (session.revoked || Date.now() >= deadline) throw new CredentialError('credential_request_gone', 410)
      const authorized = await capability.stillAuthorized()
      if (session.revoked || !authorized || Date.now() >= deadline) throw new CredentialError('credential_request_gone', 410)
    }
    try {
      await bounded(Promise.all(session.active), 2500)
      this.#move(session, 'isolated')
      session.page.setDefaultTimeout(2500)
      const allowed = new Set([policy.formURL, policy.submitURL, policy.successURL])
      await this.#routes(session, allowed)
      await check()
      await session.page.goto(policy.formURL, { waitUntil: 'domcontentloaded', timeout: 3000 })
      if (session.page.url() !== policy.formURL) throw new CredentialError('browser_origin_mismatch', 403)
      await check()
      const confirmTarget = async (): Promise<ElementHandle<HTMLElement | SVGElement>> => {
        await check()
        if (session.page.url() !== policy.formURL || await session.page.locator(policy.secretSelector).count() !== 1 || await session.page.locator(policy.submitSelector).count() !== 1) throw new CredentialError('browser_handoff_required', 422)
        const target = await session.page.locator(policy.secretSelector).elementHandle()
        const submit = await session.page.locator(policy.submitSelector).elementHandle()
        if (!target || !submit || !await target.evaluate((element, expected) => {
            const input = element as HTMLInputElement, form = input.form
            return input.tagName === 'INPUT' && input.type === 'password' && !!form && form.method.toLowerCase() === 'post' && form.action === expected && (!form.target || form.target === '_self')
          }, policy.submitURL) || !await submit.evaluate((element, input) => {
            const button = element as HTMLButtonElement
            return (button.tagName === 'BUTTON' || button.tagName === 'INPUT') && button.type === 'submit' && button.form === (input as HTMLInputElement).form && !button.hasAttribute('formaction') && !button.hasAttribute('formtarget') && !button.hasAttribute('formmethod')
          }, target) || !await target.isVisible() || !await target.isEnabled() || !await target.isEditable() || !await submit.isVisible() || !await submit.isEnabled()) throw new CredentialError('browser_handoff_required', 422)
        return target
      }
      let target = await confirmTarget()
      secret = await capability.resolveAndAdmit()
      await check()
      passwordHash = createHash('sha256').update(secret).digest('hex')
      passwordLength = secret.length
      try {
        await target.fill(secret, { timeout: 1200 })
        if (!await target.evaluate((element, value) => (element as HTMLInputElement).value === value, secret)) throw new Error()
      } catch {
        // Exactly one keyboard fallback. Reconfirm origin/form/unique editable password target
        // while the same global observer fence remains held; never guess another selector.
        target = await confirmTarget()
        try {
          await target.click({ timeout: 1000 })
          if (!await target.evaluate(element => element === document.activeElement)) throw new Error()
          await target.press('ControlOrMeta+A', { timeout: 500 }); await target.press('Backspace', { timeout: 500 })
          await check()
          if (session.page.url() !== policy.formURL) throw new CredentialError('browser_origin_mismatch', 403)
          await target.type(secret, { timeout: 1500 })
          if (!await target.evaluate((element, value) => (element as HTMLInputElement).value === value, secret)) throw new Error()
        } catch (error) {
          if (error instanceof CredentialError) throw error
          throw new CredentialError('browser_handoff_required', 422)
        }
      }
      secret = undefined
      this.#move(session, 'filled')
      await check()
      if (session.page.url() !== policy.formURL) throw new CredentialError('browser_origin_mismatch', 403)
      await Promise.all([
        session.page.waitForURL(policy.successURL, { waitUntil: 'domcontentloaded', timeout: 3000 }),
        session.page.locator(policy.submitSelector).click(),
      ])
      this.#move(session, 'submitted'); this.#move(session, 'verifying')
      await check()
      if (session.page.url() !== policy.successURL || !await session.page.locator(policy.verifiedSelector).isVisible()) throw new CredentialError('browser_verification_failed', 502)
      success = true
    } catch (error) {
      // Playwright errors include typed text and protocol arguments. Discard the original error.
      failure = error instanceof CredentialError ? error : new CredentialError('browser_execution_failed', 502)
    } finally {
      secret = undefined
      this.#move(session, 'scrubbing')
      try {
        const replacement = await this.#restore(session, policy, binding, serviceId, capability.requestId, success, passwordHash, passwordLength, capability.sessionDeadline, check)
        if (failure?.code === 'browser_handoff_required') replacement.endedReference = capability.requestId
        if (replacement.authenticated) { retained = replacement; retainedExpiresAt = new Date(replacement.authenticated.expiresAt).toISOString() }
        await this.#install(session, replacement, capability.requestId)
      } catch (error) {
        await this.#destroy(session).catch(() => {})
        this.#move(session, 'quarantined')
        // Keep old session fenced. Nothing can read it or resume it by timeout.
        failure = error instanceof CredentialError && error.code === 'credential_request_gone' ? error : new CredentialError('browser_cleanup_quarantined', 503)
      }
      session.executing = false
    }
    if (failure) throw failure
    if (!success) throw new CredentialError('browser_execution_failed', 502)
    return { result: 'site_policy_verified', cleanup: retained ? 'password_context_destroyed_auth_retained' : 'isolated_context_destroyed', phase: 'restored', ...(retained ? { sessionExpiresAt: retainedExpiresAt } : {}) }
  }

  async close(binding: Binding) {
    const session = this.#session(binding)
    if (session.fenced) throw new CredentialError('browser_isolation_locked', 423)
    session.fenced = true
    await bounded(Promise.all(session.active), 2500)
    await this.end(binding)
  }
}
