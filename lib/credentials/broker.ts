import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { CredentialError, denied, browserTaskActionSchema, type BrowserTaskAction, type Binding, type Principal, type CredentialState, type CredentialView } from './contracts'
import type { CredentialVault } from './vault'
import { executeHeader, serviceFingerprint, type HeaderService } from './services'
import type { OwnedChromiumExecutor } from './owned-chromium'

type Row = {
  id: string; owner_id: string; workspace_id: string; task_id: string; run_id: string;
  execution_session: string; auth_session_id: string; service_id: string; target_origin: string;
  mode: 'api_header' | 'browser_login'; state: CredentialState; nonce_hash: string; service_policy_hash: string;
  vault_ref: string; retention: 'once' | 'session'; expires_at: Date; use_expires_at: Date | null;
  cleanup_pending: boolean; version: number
}
export interface CredentialAuthority {
  resolve(principal: Principal, workspaceId: string, runId: string, client?: PoolClient): Promise<Binding | null>
}
const terminal = new Set<CredentialState>(['consumed', 'cancelled', 'expired', 'failed', 'disconnected', 'handoff_required'])
const digest = (s: string) => createHash('sha256').update(s).digest('hex')
function view(row: Row): CredentialView {
  return {
    id: row.id, credentialRef: row.id, serviceId: row.service_id, targetOrigin: row.target_origin,
    mode: row.mode, state: row.state, retention: row.retention,
    expiresAt: row.expires_at.toISOString(), useExpiresAt: row.use_expires_at?.toISOString() ?? null,
    cleanupPending: row.cleanup_pending, version: row.version,
  }
}

export class CredentialBroker {
  constructor(private readonly options: {
    pool: Pool; vault: CredentialVault; authority: CredentialAuthority;
    services: ReadonlyMap<string, HeaderService>;
    browser?: OwnedChromiumExecutor;
    notifyReady?: (binding: Binding, reference: string, serviceId: string) => Promise<void>;
  }) {}

  serviceInfo(serviceId: string, mode: 'api_header' | 'browser_login') {
    const info = mode === 'browser_login' ? this.options.browser?.describe(serviceId) : this.options.services.get(serviceId)
    if (!info) throw new CredentialError(mode === 'browser_login' ? 'browser_isolation_unavailable' : 'credential_service_unavailable', mode === 'browser_login' ? 501 : 422)
    return { serviceId, targetOrigin: 'targetOrigin' in info ? info.targetOrigin : new URL(info.endpoint).origin, mode }
  }

  async forRun(reference: string, actor: { userId: string; runId: string; taskId: string }) {
    const row = await this.row(reference)
    if (row.owner_id !== actor.userId || row.run_id !== actor.runId || row.task_id !== actor.taskId) denied()
    return { ...this.binding(row), serviceId: row.service_id }
  }

  private async row(id: string, principal?: Principal, client: Pool | PoolClient = this.options.pool): Promise<Row> {
    const { rows } = await client.query<Row>('SELECT * FROM credential_requests WHERE id=$1', [id])
    const row = rows[0]
    if (!row || (principal && (row.owner_id !== principal.ownerId || row.auth_session_id !== principal.authSessionId))) denied()
    return row
  }

  private async revoke(id: string, state: 'cancelled' | 'expired' | 'failed' | 'disconnected' | 'handoff_required', client: Pool | PoolClient = this.options.pool) {
    await client.query(`UPDATE credential_requests SET state=$2, cleanup_pending=true, version=version+1, updated_at=now()
      WHERE id=$1 AND state IN ('pending','submitting','ready','using','active_session')`, [id, state])
  }

  private async live(row: Row, client?: PoolClient): Promise<boolean> {
    if (terminal.has(row.state)) return false
    if ((row.use_expires_at ?? row.expires_at).getTime() <= Date.now()) {
      await this.revoke(row.id, 'expired', client); return false
    }
    const binding = await this.options.authority.resolve({ ownerId: row.owner_id, authSessionId: row.auth_session_id }, row.workspace_id, row.run_id, client)
    if (!binding || binding.taskId !== row.task_id || binding.executionSession !== row.execution_session) {
      await this.revoke(row.id, 'disconnected', client); return false
    }
    return true
  }

  /** Session advisory locks cover the vault/network operation across all app instances.
   * Cancellation updates state without waiting for this lock; cleanup retries durably. */
  private async locked<T>(id: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect()
    let locked = false
    let broken = false
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 71921)) AS locked', [id])
      locked = rows[0].locked
      if (!locked) throw new CredentialError('credential_busy', 409)
      return await fn(client)
    } finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 71921))', [id]) }
        catch { broken = true }
      }
      client.release(broken)
    }
  }

  private async cleanupLocked(id: string, client: Pool | PoolClient) {
    const row = await this.row(id, undefined, client)
    if (!row.cleanup_pending || (!terminal.has(row.state) && row.state !== 'active_session')) return
    try {
      if (terminal.has(row.state) && row.mode === 'browser_login') await this.options.browser?.end(this.binding(row), row.id)
      await this.options.vault.remove(row.vault_ref)
      await client.query('UPDATE credential_requests SET cleanup_pending=false, version=version+1, updated_at=now() WHERE id=$1 AND cleanup_pending', [id])
    } catch {
      // Keep the tombstone and reference for the next cleanup pass. No provider exception escapes.
    }
  }

  async cleanup(id: string) {
    try { await this.locked(id, c => this.cleanupLocked(id, c)) }
    catch (error) { if (!(error instanceof CredentialError && error.code === 'credential_busy')) throw error }
  }

  async create(principal: Principal, input: { workspaceId: string; runId: string; serviceId: string; mode: 'api_header' | 'browser_login' }) {
    const binding = await this.options.authority.resolve(principal, input.workspaceId, input.runId)
    if (!binding) denied()
    await this.sweep(20)
    const create = async (client: Pool | PoolClient) => {
      // Existing shared browsers stay unsupported. Only an attached, newly owned session qualifies.
      const browserPolicy = input.mode === 'browser_login' ? await this.options.browser?.prepare(binding, input.serviceId) : undefined
      if (input.mode === 'browser_login' && !browserPolicy) throw new CredentialError('browser_isolation_unavailable', 501)
      const service = this.options.services.get(input.serviceId)
      if (input.mode === 'api_header' && !service) throw new CredentialError('credential_service_unavailable', 422)
      const id = randomUUID(), vaultRef = randomUUID(), nonce = randomBytes(32).toString('base64url')
      try {
        await client.query(`INSERT INTO credential_requests
          (id, owner_id, workspace_id, task_id, run_id, execution_session, auth_session_id, service_id, target_origin,
           mode, state, nonce_hash, vault_ref, retention, expires_at, service_policy_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,'once',now()+interval '5 minutes',$13)`,
        [id, binding.ownerId, binding.workspaceId, binding.taskId, binding.runId, binding.executionSession,
          principal.authSessionId, input.serviceId, browserPolicy?.origin ?? new URL(service!.endpoint).origin, input.mode, digest(nonce), vaultRef,
          browserPolicy?.fingerprint ?? serviceFingerprint(service!)])
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new CredentialError('credential_request_exists', 409)
        throw error
      }
      if (input.mode === 'browser_login') {
        try { this.options.browser!.claim(binding, id) }
        catch (error) { await this.revoke(id, 'failed', client); await this.cleanupLocked(id, client); throw error }
      }
      return { ...view(await this.row(id, principal, client)), nonce }
    }
    // One browser generation belongs to one request, even across service ids and app instances.
    return input.mode === 'browser_login'
      ? this.locked(`browser-create:${binding.ownerId}:${binding.runId}:${binding.executionSession}`, create)
      : create(this.options.pool)
  }

  async get(principal: Principal, id: string) {
    const row = await this.row(id, principal)
    await this.live(row)
    await this.cleanup(id)
    return view(await this.row(id, principal))
  }

  async submit(principal: Principal, id: string, input: { nonce: string; secret: string; save: boolean }) {
    const original = await this.row(id, principal)
    if (!timingSafeEqual(Buffer.from(digest(input.nonce)), Buffer.from(original.nonce_hash))) throw new CredentialError('credential_nonce_invalid', 403)
    const result = await this.locked(id, async client => {
      let row = await this.row(id, principal, client)
      try {
        if (!await this.live(row, client)) throw new CredentialError('credential_request_gone', 410)
        const claimed = await client.query(`UPDATE credential_requests SET state='submitting', retention=$2,
          cleanup_pending=true, version=version+1, updated_at=now()
          WHERE id=$1 AND state='pending' AND expires_at>now() RETURNING id`, [id, input.save ? 'session' : 'once'])
        if (!claimed.rowCount) throw new CredentialError('credential_already_submitted', 409)
        // Reference is durable before put: an unknown write result remains cleanable after a crash.
        await this.options.vault.put(row.vault_ref, input.secret)
        row = await this.row(id, principal, client)
        if (!await this.live(row, client)) throw new CredentialError('credential_request_gone', 410)
        const ready = await client.query(`UPDATE credential_requests SET state='ready', cleanup_pending=false,
          use_expires_at=now()+CASE WHEN retention='session' THEN interval '24 hours' ELSE interval '10 minutes' END,
          version=version+1, updated_at=now() WHERE id=$1 AND state='submitting' AND expires_at>now() RETURNING id`, [id])
        if (!ready.rowCount) throw new CredentialError('credential_request_gone', 410)
        return view(await this.row(id, principal, client))
      } catch (error) {
        // A replay/busy failure must not invalidate a previously accepted credential.
        row = await this.row(id, principal, client)
        if (row.state === 'submitting') await this.revoke(id, 'failed', client)
        if (error instanceof CredentialError) throw error
        throw new CredentialError('credential_submission_failed', 503)
      } finally { await this.cleanupLocked(id, client) }
    })
    if (this.options.notifyReady) await this.options.notifyReady(this.binding(original), id, original.service_id).catch(() => {})
    return result
  }

  async cancel(principal: Principal, id: string) {
    const original = await this.row(id, principal)
    await this.revoke(id, 'cancelled')
    if (original.mode === 'browser_login') await this.options.browser?.end(this.binding(original), original.id)
    await this.cleanup(id)
    return view(await this.row(id, principal))
  }

  /** Trusted server executor only. No route/tool returns plaintext or accepts a secret. */
  async use(reference: string, expected: Binding & { serviceId: string }) {
    return this.locked(reference, async client => {
      const row = await this.row(reference, undefined, client)
      this.requireExpected(row, expected)
      const service = this.options.services.get(row.service_id)
      const browserPolicy = row.mode === 'browser_login' ? this.options.browser?.policy(row.service_id, expected) : undefined
      const policyValid = row.mode === 'browser_login'
        ? browserPolicy?.origin === row.target_origin && browserPolicy.fingerprint === row.service_policy_hash
        : service && new URL(service.endpoint).origin === row.target_origin && serviceFingerprint(service) === row.service_policy_hash
      if (!policyValid) {
        await this.revoke(reference, 'failed', client)
        await this.cleanupLocked(reference, client)
        throw new CredentialError('credential_service_unavailable', 422)
      }
      let admitted = false
      let attemptedRead = false
      try {
        if (!await this.live(row, client)) throw new CredentialError('credential_request_gone', 410)
        if (row.state !== 'ready') throw new CredentialError('credential_not_ready', 409)
        const resolveAndAdmit = async () => {
          attemptedRead = true
          const secret = await this.options.vault.read(row.vault_ref)
          // Recheck authority, expiry and cancellation after provider IO, immediately before admission.
          if (!await this.live(await this.row(reference, undefined, client), client)) throw new CredentialError('credential_request_gone', 410)
          const claim = await client.query(`UPDATE credential_requests SET state='using', version=version+1, updated_at=now()
            WHERE id=$1 AND state='ready' AND use_expires_at>now() RETURNING id`, [reference])
          if (!claim.rowCount) throw new CredentialError('credential_request_gone', 410)
          admitted = true
          return secret
        }
        const lease = row.mode === 'browser_login' ? await client.query('SELECT "leaseExpiresAt" FROM agent_runs WHERE id=$1 AND "userId"=$2', [row.run_id, row.owner_id]) : undefined
        const sessionDeadline = Math.min(row.use_expires_at!.getTime(), lease ? new Date(lease.rows[0]?.leaseExpiresAt ?? 0).getTime() : Infinity)
        const result = row.mode === 'browser_login'
          ? await this.options.browser!.execute(expected, row.service_id, {
            requestId: reference,
            sessionDeadline,
            resolveAndAdmit,
            stillAuthorized: async () => {
              const current = await this.row(reference, undefined, client)
              return (current.state === 'ready' || current.state === 'using') && await this.live(current, client)
            },
          })
          : await executeHeader(service!, await resolveAndAdmit(), AbortSignal.timeout(Math.max(1, Math.min(5000, row.use_expires_at!.getTime() - Date.now()))))
        const retained = 'cleanup' in result && result.cleanup === 'password_context_destroyed_auth_retained'
        await client.query(`UPDATE credential_requests SET state=CASE WHEN $2 THEN 'active_session' WHEN retention='once' THEN 'consumed' ELSE 'ready' END,
          cleanup_pending=($2 OR retention='once'), use_expires_at=CASE WHEN $2 THEN LEAST(use_expires_at,$3::timestamptz) ELSE use_expires_at END,
          version=version+1, updated_at=now() WHERE id=$1 AND state='using'`, [reference, retained, 'sessionExpiresAt' in result ? result.sessionExpiresAt : null])
        if (retained && (await this.row(reference, undefined, client)).state !== 'active_session') {
          await this.options.browser?.end(expected, reference)
          throw new CredentialError('credential_request_gone', 410)
        }
        return result
      } catch (error) {
        if (row.mode === 'browser_login' || admitted || attemptedRead || !(error instanceof CredentialError)) await this.revoke(reference, error instanceof CredentialError && error.code === 'browser_handoff_required' ? 'handoff_required' : 'failed', client)
        if (row.mode === 'browser_login') await this.options.browser?.end(expected, reference)
        if (error instanceof CredentialError) throw error
        throw new CredentialError('credential_execution_failed', 502)
      } finally { await this.cleanupLocked(reference, client) }
    })
  }

  private binding(row: Row): Binding {
    return { ownerId: row.owner_id, workspaceId: row.workspace_id, taskId: row.task_id, runId: row.run_id,
      executionSession: row.execution_session, authSessionId: row.auth_session_id }
  }

  private requireExpected(row: Row, expected: Binding & { serviceId: string }) {
    if (row.owner_id !== expected.ownerId || row.workspace_id !== expected.workspaceId || row.task_id !== expected.taskId ||
      row.run_id !== expected.runId || row.execution_session !== expected.executionSession ||
      row.auth_session_id !== expected.authSessionId || row.service_id !== expected.serviceId) denied()
  }

  /** Reference-only post-login action; expected identity comes from trusted server auth/task context. */
  async continueBrowser(reference: string, expected: Binding & { serviceId: string }, action?: BrowserTaskAction) {
    if (action && !browserTaskActionSchema.safeParse(action).success) throw new CredentialError('browser_action_not_allowed', 400)
    return this.locked(reference, async client => {
      const row = await this.row(reference, undefined, client), binding = this.binding(row)
      this.requireExpected(row, expected)
      try {
        if (row.state !== 'active_session' || !await this.live(row, client)) throw new CredentialError('credential_request_gone', 410)
        if (!this.options.browser) throw new CredentialError('browser_isolation_unavailable', 501)
        const authorized = async () => {
          const current = await this.row(reference, undefined, client)
          return current.state === 'active_session' && await this.live(current, client)
        }
        return action ? await this.options.browser.taskAction(binding, row.service_id, reference, action, authorized)
          : await this.options.browser.readProtected(binding, row.service_id, reference, authorized)
      } catch (error) {
        await this.options.browser?.end(binding, reference)
        await this.revoke(reference, 'failed', client)
        if (error instanceof CredentialError) throw error
        throw new CredentialError('browser_execution_failed', 502)
      } finally { await this.cleanupLocked(reference, client) }
    })
  }

  async finishBrowser(reference: string, expected: Binding & { serviceId: string }) {
    return this.locked(reference, async client => {
      const row = await this.row(reference, undefined, client)
      this.requireExpected(row, expected)
      await client.query(`UPDATE credential_requests SET state='consumed', cleanup_pending=true, version=version+1, updated_at=now()
        WHERE id=$1 AND state IN ('pending','submitting','ready','using','active_session')`, [reference])
      if (row.mode === 'browser_login') await this.options.browser?.end(this.binding(row), reference)
      await this.cleanupLocked(reference, client)
      return view(await this.row(reference, undefined, client))
    })
  }

  /** Call synchronously on a trusted execution-session disconnect. Also detected on each use/sweep. */
  async disconnect(ownerId: string, runId: string, executionSession: string) {
    const { rows } = await this.options.pool.query(`UPDATE credential_requests SET state='disconnected', cleanup_pending=true,
      version=version+1, updated_at=now() WHERE owner_id=$1 AND run_id=$2 AND execution_session=$3
      AND state IN ('pending','submitting','ready','using','active_session') RETURNING *`, [ownerId, runId, executionSession])
    for (const row of rows) {
      await this.cleanup(row.id)
    }
  }

  async sweep(limit = 100) {
    // Keep tombstones indefinitely, including successful deletions. A timed-out provider write
    // can finish after a delete; periodic idempotent deletion repairs that unknown outcome.
    const { rows } = await this.options.pool.query<Row>(`SELECT * FROM credential_requests ORDER BY updated_at LIMIT $1`, [limit])
    for (const row of rows) {
      const live = await this.live(row)
      if (live && row.state === 'ready' && this.options.notifyReady) await this.options.notifyReady(this.binding(row), row.id, row.service_id).catch(() => {})
      // A crashed submitting/using operation is never resumed. Lock acquisition proves no worker owns it.
      try {
        await this.locked(row.id, async client => {
          const current = await this.row(row.id, undefined, client)
          if (current.state === 'submitting' || current.state === 'using') await this.revoke(row.id, 'failed', client)
          if (terminal.has(current.state) && !current.cleanup_pending) await client.query('UPDATE credential_requests SET cleanup_pending=true WHERE id=$1', [row.id])
          await this.cleanupLocked(row.id, client)
          await client.query('UPDATE credential_requests SET updated_at=now() WHERE id=$1', [row.id])
        })
      } catch (error) { if (!(error instanceof CredentialError && error.code === 'credential_busy')) throw error }
    }
    return { checked: rows.length }
  }
}
