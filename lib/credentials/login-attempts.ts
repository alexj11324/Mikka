import { randomUUID } from 'node:crypto'
import { CredentialError, type Actor, type BrowserCaller } from './contracts'
import { classifyLoginSignal, type LoginAttemptReason, type LoginAttemptStatus, type LoginPageSnapshot, type LoginSignal, type LoginStep } from './login-signal'

export const LOGIN_ATTEMPT_TTL_MS = 10 * 60_000
type Queryable = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

export type LoginAttemptView = { attemptId: string; site: string; status: LoginAttemptStatus; reason?: LoginAttemptReason; createdAt: string; expiresAt: string; updatedAt: string }
const LIVE = ['waiting', 'needs_code'] as const

function view(row: any): LoginAttemptView {
  return { attemptId: row.id, site: row.site, status: row.status, ...(row.reason ? { reason: row.reason } : {}), createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }
}

/** login_attempts holds status only: no username, password, code or ciphertext. */
export const loginAttemptsTable = {
  async create(db: Queryable, caller: BrowserCaller, site: string, ttlMs = LOGIN_ATTEMPT_TTL_MS) {
    const row = (await db.query(`INSERT INTO login_attempts(id,user_id,workspace_id,bot_id,subagent_id,run_id,site,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'waiting',now()+($8::int * interval '1 millisecond')) RETURNING *`,
      [randomUUID(), caller.userId, caller.workspaceId, caller.botId, caller.subagentId ?? null, caller.runId ?? null, site, ttlMs])).rows[0]
    return view(row)
  },
  /** Only live attempts move; terminal states are final. Returns null if nothing moved. */
  async transition(db: Queryable, actor: Actor, attemptId: string, status: LoginAttemptStatus, reason: LoginAttemptReason | null) {
    const row = (await db.query(`UPDATE login_attempts SET status=$4,reason=$5,updated_at=now() WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND status = ANY($6::text[]) RETURNING *`,
      [attemptId, actor.userId, actor.workspaceId, status, reason, LIVE])).rows[0]
    return row ? view(row) : null
  },
  /** GET: one plain SELECT on this table, no locks, no writes; other owners/workspaces see 404. */
  async read(db: Queryable, actor: Actor, attemptId: string, scope: { botId?: string; subagentId?: string; runId?: string } = {}) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)) throw new CredentialError('credential_denied', 404)
    const row = (await db.query('SELECT id,site,status,reason,created_at,expires_at,updated_at FROM login_attempts WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND ($4::uuid IS NULL OR bot_id=$4) AND ($5::uuid IS NULL OR subagent_id=$5) AND ($6::uuid IS NULL OR run_id=$6)', [attemptId, actor.userId, actor.workspaceId, scope.botId ?? null, scope.subagentId ?? null, scope.runId ?? null])).rows[0]
    if (!row) throw new CredentialError('credential_denied', 404)
    // An attempt past its TTL reads as expired even before the runtime records it (no write here).
    if ((LIVE as readonly string[]).includes(row.status) && new Date(row.expires_at).getTime() <= Date.now()) return { ...view(row), status: 'expired' as const, reason: undefined }
    return view(row)
  },
}

/** The browser session that typed the credential; owned by the runtime process. */
export interface LoginSession {
  submitPassword(username: string, password: string): Promise<void>
  submitCode(code: string): Promise<void>
  /** Definite page facts right now. stepUrl is filled in by the runtime. */
  snapshot(): Promise<Omit<LoginPageSnapshot, 'stepUrl'>>
  close(): Promise<void>
}

type Pending = { caller: BrowserCaller; site: string; username: string; password: string; session: LoginSession; step: LoginStep; stepUrl: string; timer: ReturnType<typeof setTimeout>; expiresAt: number; observing: number }

export type LoginAttemptDeps = {
  db: Queryable
  openSession(caller: BrowserCaller, site: string): Promise<LoginSession>
  /** The existing secret path; called only after a definite signed_in. */
  saveCredential(caller: BrowserCaller, input: { origin: string; username: string; password: string }): Promise<unknown>
  ttlMs?: number
  /** How long a request waits for a definite signal before returning `waiting`. */
  observeWindowMs?: number
  pollMs?: number
}

/**
 * In-memory pending logins for this process. The credential is never written to the DB
 * until signed_in, and is dropped on every other terminal state or at the TTL.
 */
export class LoginAttemptRuntime {
  readonly pending = new Map<string, Pending>()
  constructor(private deps: LoginAttemptDeps) {}
  private get ttl() { return this.deps.ttlMs ?? LOGIN_ATTEMPT_TTL_MS }

  async start(caller: BrowserCaller, input: { origin: string; username: string; password: string }) {
    const session = await this.deps.openSession(caller, input.origin)
    const attempt = await loginAttemptsTable.create(this.deps.db, caller, input.origin, this.ttl)
    const expiresAt = Date.now() + this.ttl
    const timer = setTimeout(() => { void this.expire(attempt.attemptId) }, this.ttl)
    timer.unref?.()
    const entry: Pending = { caller, site: input.origin, username: input.username, password: input.password, session, step: 'password', stepUrl: '', timer, expiresAt, observing: 0 }
    this.pending.set(attempt.attemptId, entry)
    try {
      entry.stepUrl = (await session.snapshot()).url
      await session.submitPassword(input.username, input.password)
    } catch {
      await this.finish(attempt.attemptId, 'expired', 'sessionLost')
      return this.result(attempt.attemptId, caller)
    }
    return this.observe(attempt.attemptId)
  }

  /** needs_code: the user sends only the code, typed into the same live session. */
  async submitCode(actor: Actor, attemptId: string, code: string) {
    const current = await loginAttemptsTable.read(this.deps.db, actor, attemptId)
    const entry = this.pending.get(attemptId)
    if (current.status !== 'needs_code') {
      if (current.status === 'expired' && entry) await this.finish(attemptId, 'expired', null)
      if (current.status === 'expired' || current.status === 'waiting') throw new CredentialError('login_attempt_not_waiting_for_code', 409)
      throw new CredentialError('login_attempt_ended', 409)
    }
    if (!entry || entry.caller.userId !== actor.userId || entry.caller.workspaceId !== actor.workspaceId) {
      // Session or memory gone (restart / other instance): expire; the user resubmits.
      await loginAttemptsTable.transition(this.deps.db, actor, attemptId, 'expired', 'sessionLost')
      return this.result(attemptId, actor)
    }
    try {
      entry.stepUrl = (await entry.session.snapshot()).url
      entry.step = 'code'
      await entry.session.submitCode(code)
    } catch {
      await this.finish(attemptId, 'expired', 'sessionLost')
      return this.result(attemptId, actor)
    }
    await loginAttemptsTable.transition(this.deps.db, actor, attemptId, 'waiting', null)
    return this.observe(attemptId)
  }

  private async result(attemptId: string, actor: Actor) {
    return loginAttemptsTable.read(this.deps.db, actor, attemptId)
  }

  private async observe(attemptId: string) {
    const entry = this.pending.get(attemptId)!
    const caller = entry.caller
    const token = ++entry.observing
    const until = Date.now() + (this.deps.observeWindowMs ?? 20_000)
    while (Date.now() < until && this.pending.get(attemptId) === entry && entry.observing === token) {
      if (await this.poll(attemptId, entry)) break
      await new Promise(resolve => setTimeout(resolve, this.deps.pollMs ?? 500))
    }
    // No definite signal in the window: keep watching in the background until the TTL.
    if (this.pending.get(attemptId) === entry && entry.observing === token) void this.background(attemptId, entry, token)
    return this.result(attemptId, caller)
  }

  private async background(attemptId: string, entry: Pending, token: number) {
    while (this.pending.get(attemptId) === entry && entry.observing === token && Date.now() < entry.expiresAt) {
      await new Promise(resolve => { const t = setTimeout(resolve, this.deps.pollMs ?? 500); t.unref?.() })
      if (this.pending.get(attemptId) !== entry || entry.observing !== token) return
      if (await this.poll(attemptId, entry).catch(() => false)) return
    }
  }

  /** true when a definite signal was applied (stop observing this step). */
  private async poll(attemptId: string, entry: Pending): Promise<boolean> {
    let page: Omit<LoginPageSnapshot, 'stepUrl'>
    try { page = await entry.session.snapshot() } catch { await this.finish(attemptId, 'expired', 'sessionLost'); return true }
    const signal = classifyLoginSignal(entry.step, { ...page, stepUrl: entry.stepUrl })
    return this.apply(attemptId, entry, signal)
  }

  private async apply(attemptId: string, entry: Pending, signal: LoginSignal) {
    if (signal.status === 'waiting') return false
    if (signal.status === 'needs_code') {
      if (entry.step !== 'password') return false
      await loginAttemptsTable.transition(this.deps.db, entry.caller, attemptId, 'needs_code', 'twoFactorRequired')
      return true
    }
    if (signal.status === 'rejected') { await this.finish(attemptId, 'rejected', signal.reason); return true }
    // signed_in: persist through the existing secret path first, then record the status.
    try {
      await this.deps.saveCredential(entry.caller, { origin: entry.site, username: entry.username, password: entry.password })
    } catch {
      await this.finish(attemptId, 'expired', 'saveFailed')
      return true
    }
    await this.finish(attemptId, 'signed_in', null)
    return true
  }

  private async expire(attemptId: string) {
    if (this.pending.has(attemptId)) await this.finish(attemptId, 'expired', null).catch(() => {})
  }

  /** Terminal: drop the pending credential from memory and close the session handle. */
  private async finish(attemptId: string, status: 'signed_in' | 'rejected' | 'expired', reason: LoginAttemptReason | null) {
    const entry = this.pending.get(attemptId)
    if (entry) {
      this.pending.delete(attemptId)
      clearTimeout(entry.timer)
      entry.password = ''; entry.username = ''
      await entry.session.close().catch(() => {})
      await loginAttemptsTable.transition(this.deps.db, entry.caller, attemptId, status, reason)
    }
  }
}
