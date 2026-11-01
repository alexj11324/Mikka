import { randomUUID } from 'node:crypto'
import { MailboxError } from './mailbox-error'
export { MailboxError } from './mailbox-error'
import { personalPeerText, presentPersonalInboxRow } from './personal-mailbox-presentation'
import { PERSONAL_MESSAGE_INSTRUCTIONS } from './personal-agent-message'
import type { Pool, PoolClient } from 'pg'
import type { MailboxFence } from './personal-mailbox-fence'
import { waitForMailboxGuard, type MailboxTransactionGuard, type MailboxTransactionLease } from './mailbox-transaction-guard'
import { cancelMailboxBackend } from './mailbox-pg-cancel'
import { mailboxDiagnostic } from './mailbox-diagnostics'

// Deliberately no global database: the caller supplies its request-scoped pool.
// A peer never supplies userId/workspaceId or its own sender identity over HTTP.
export interface MailboxActor { userId: string; workspaceId: string; mailboxId: string; runId?: string; runTokenHash?: string }
export interface Mailbox { id: string; userId: string; workspaceId: string; kind: 'run' | 'coordinator' | 'bot' | 'group'; sessionKey: string; latestRunId: string | null; disabled: boolean; wakeBudget: number; harness: string | null }
export interface MailboxReceipt { id: string; queued: true; duplicate: boolean; failure: string | null; continuationRunId?: string }
const LIVE = ['queued', 'preparing', 'running', 'waiting_input', 'finishing']
function liveLease(value: Date | string | null | undefined): boolean {
  const expires = value == null ? NaN : new Date(value).getTime()
  return Number.isFinite(expires) && expires > Date.now()
}

export class SessionMailbox {
  constructor(private readonly pool: Pool, private readonly workspaceId: string, private readonly fence?: MailboxFence, private readonly guard?: MailboxTransactionGuard) {}
  private async transaction<T>(fn: (client: PoolClient) => Promise<T>, recheck?: (client: PoolClient) => Promise<unknown>): Promise<T> {
    // Reserve APP first: AgentKit initialization already holds APP/head before
    // asking workspace authorization. Opposite pool/head order can deadlock.
    const deadline = this.guard ? new AbortController() : undefined
    const timer = deadline ? setTimeout(() => deadline.abort(), 20000) : undefined
    timer?.unref()
    const outerSignal = deadline ? AbortSignal.any([deadline.signal, ...(this.guard?.signal ? [this.guard.signal] : [])]) : undefined
    let lease: MailboxTransactionLease | undefined
    let closingLease: Promise<void> | undefined
    const closeLease = () => lease ? closingLease ??= Promise.resolve().then(() => lease!.close()) : Promise.resolve()
    const signal = () => lease?.signal && outerSignal ? AbortSignal.any([outerSignal, lease.signal]) : outerSignal
    let rawClient: PoolClient | undefined, admissionClosed = false
    const appFailure = () => deadline?.abort()
    let client: PoolClient | undefined, began = false, committed = false, committing = false, discard: Error | undefined
    try {
      if (outerSignal?.aborted) throw new MailboxError('Mailbox authorization cancelled before admission', 403)
      const connection = this.pool.connect().then(raw => {
        // Register custody before the callback/await handoff can lose a race
        // to abort. A genuinely late checkout still discards itself once.
        rawClient = raw
        if (this.guard) { raw.on?.('error', appFailure); raw.on?.('end', appFailure) }
        if (admissionClosed || outerSignal?.aborted) {
          rawClient = undefined
          raw.removeListener?.('error', appFailure); raw.removeListener?.('end', appFailure)
          raw.release(new Error('Mailbox lease lost before app admission'))
          throw new MailboxError('Mailbox authorization lease lost', 403)
        }
        return raw
      })
      const raw = await waitForMailboxGuard(connection, outerSignal)
      if (outerSignal?.aborted) throw new MailboxError('Mailbox authorization lease lost', 403)
      mailboxDiagnostic('app.checkout', { backendPID: (raw as unknown as { processID?: number }).processID })
      // pg-pool removes its idle listener while a client is checked out.
      // Own this transaction's socket failures until release transfers custody
      // back to the pool (or destroys it). Otherwise a disconnect can escape
      // as an unhandled EventEmitter error instead of a bounded refusal.
      client = outerSignal ? new Proxy(raw, { get(target, key) {
        if (key === 'query') return (...args: unknown[]) => {
          const current = signal()
          if (current?.aborted) return Promise.reject(new MailboxError('Mailbox authorization cancelled before query', 403))
          const pending = Reflect.apply(target.query, target, args) as Promise<unknown>
          pending.then(() => mailboxDiagnostic('app.query.end'), error => mailboxDiagnostic('app.query.error', { sqlState: /^[A-Z0-9]{5}$/.test(error?.code) ? error.code : undefined }))
          return waitForMailboxGuard(pending, current)
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } }) : raw
      await client.query('begin'); began = true
      if (this.guard) {
        await client.query("select set_config('lock_timeout','5s',true),set_config('statement_timeout','10s',true),set_config('idle_in_transaction_session_timeout','30s',true)")
        const pending = this.guard(client, outerSignal!).then(async value => {
          // Register the lease before the callback/await ownership handoff.
          // A return after APP cleanup closes itself; while APP is still held,
          // its finally owns the APP-before-WS release order.
          lease = value
          if (admissionClosed || outerSignal?.aborted) {
            if (!rawClient) await closeLease()
            throw new MailboxError('Mailbox authorization lease lost', 403)
          }
          return value
        })
        lease = await waitForMailboxGuard(pending, outerSignal)
      }
      await lease?.check()
      await this.fence?.(client, lease)
      const value = await fn(client)
      // Authority rows stay locked through COMMIT; a fresh check after data
      // waits also catches lease/token expiry while this transaction ran.
      await recheck?.(client)
      await this.fence?.(client, lease)
      await lease?.check()
      // Authorization decision linearizes here with the member SHARE lease.
      // There is no await between the final check and sending COMMIT.
      if (signal()?.aborted) throw new MailboxError('Mailbox authorization cancelled before commit', 403)
      committing = true
      await client.query('commit'); began = false; committed = true
      await lease?.check()
      return value
    } catch (error) {
      if (began && client && !signal()?.aborted) {
        try { await client.query('rollback') }
        catch (cleanup) { discard = cleanup instanceof Error ? cleanup : new Error('Mailbox rollback failed') }
      } else discard = error instanceof Error ? error : new Error('Mailbox transaction admission failed')
      if (committed) throw new MailboxError('Mailbox effect committed; membership lease lost during finalization. Reconcile using the original stable key', 409, 'committed')
      if (committing) throw new MailboxError('Mailbox commit outcome unconfirmed; reconcile using the original stable key', 409, 'unconfirmed')
      throw error
    } finally {
      admissionClosed = true
      // Disconnect alone is not a server query cancellation. Send the actual
      // PG protocol request while this exact session remains checked out; no
      // caller can reuse it or enqueue another statement during cancellation.
      if (rawClient && client && signal()?.aborted && !committed) await cancelMailboxBackend(rawClient)
      mailboxDiagnostic('app.release', { backendPID: (rawClient as unknown as { processID?: number } | undefined)?.processID, aborted: signal()?.aborted, outcome: discard ? 'discard' : 'reuse' })
      try { (client ?? rawClient)?.release(discard) }
      finally {
        rawClient?.removeListener?.('error', appFailure)
        rawClient?.removeListener?.('end', appFailure)
        rawClient = undefined
      }
      await closeLease()
      clearTimeout(timer)
    }
  }
  private async ensure(client: PoolClient, userId: string, kind: Mailbox['kind'], sessionKey: string): Promise<Mailbox> {
    const { rows } = await client.query<Mailbox>(`insert into session_mailboxes (id,"userId","workspaceId",kind,"sessionKey") values ($1,$2,$3,$4,$5)
      on conflict ("userId","workspaceId",kind,"sessionKey") do nothing returning *`, [randomUUID(), userId, this.workspaceId, kind, sessionKey])
    if (rows[0]) return rows[0]
    // Existing identities need no no-op UPDATE lock.
    const existing = await client.query<Mailbox>('select * from session_mailboxes where "userId"=$1 and "workspaceId"=$2 and kind=$3 and "sessionKey"=$4', [userId,this.workspaceId,kind,sessionKey])
    if (!existing.rows[0]) throw new MailboxError('Mailbox unavailable',409)
    return existing.rows[0]
  }
  /** Only call for a verified server-side conversation identity. */
  async conversation(userId: string, kind: 'coordinator' | 'bot', sessionKey = 'coordinator'): Promise<MailboxActor> {
    return this.transaction(async client => {
      if (kind === 'bot' && !(await client.query('select 1 from bots where id=$1 and "ownerId"=$2 and "workspaceId"=$3', [sessionKey, userId, this.workspaceId])).rowCount) throw new MailboxError('Unknown conversation')
      const box = await this.ensure(client, userId, kind, sessionKey)
      return { userId, workspaceId: this.workspaceId, mailboxId: box.id }
    })
  }
  async run(userId: string, runId: string, runTokenHash?: string): Promise<MailboxActor> {
    return this.transaction(async client => {
      // Serialize first attachment before reading mailboxId. Otherwise a
      // concurrent initializer can observe null, wait for R, then lock the
      // newly attached mailbox after R (opposite to admission's B -> R).
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`mailbox-init:${this.workspaceId}:${userId}:${runId}`])
      // Mailbox before attempt: the same lock order as stop/scheduling.
      const { rows: [identity] } = await client.query('select "mailboxId" from agent_runs where id=$1 and "userId"=$2 and kind<>\'group_review\'', [runId, userId])
      if (identity?.mailboxId) await client.query('select id from session_mailboxes where id=$1 for update', [identity.mailboxId])
      const { rows: [run] } = await client.query(`select r.*,a.harness from agent_runs r join agents a on a.id=r."agentId" and a."userId"=r."userId" join devices d on d.id=r."deviceId" where r.id=$1 and r."userId"=$2 and d."ownerId"=$2 and d.enabled for update of r`, [runId, userId])
      if (!run || run.kind === 'group_review' || !LIVE.includes(run.status) || run.stopRequestedAt || !liveLease(run.leaseExpiresAt)) throw new MailboxError('Run is not authorized to use a mailbox')
      if (runTokenHash && !(await client.query('select id from run_tokens where "runId"=$1 and "userId"=$2 and "tokenHash"=$3 and "revokedAt" is null and "expiresAt">clock_timestamp() for share', [runId, userId, runTokenHash])).rowCount) throw new MailboxError('Run token is no longer authorized', 401)
      let mailboxId = run.mailboxId
      if (!mailboxId) {
        const box = await this.ensure(client, userId, 'run', runId)
        mailboxId = box.id
        await client.query('update session_mailboxes set "latestRunId"=$1 where id=$2', [runId, mailboxId])
        await client.query('update agent_runs set "mailboxId"=$1 where id=$2', [mailboxId, runId])
      }
      await client.query('update session_mailboxes set harness=coalesce(harness,$1) where id=$2 and "userId"=$3 and "workspaceId"=$4', [run.harness, mailboxId, userId, this.workspaceId])
      if (!(await client.query('select 1 from session_mailboxes where id=$1 and "userId"=$2 and "workspaceId"=$3 and not disabled', [mailboxId, userId, this.workspaceId])).rowCount) throw new MailboxError('Mailbox unavailable')
      return { userId, workspaceId: this.workspaceId, mailboxId, runId, ...(runTokenHash ? { runTokenHash } : {}) }
    })
  }
  private async authorize(client: PoolClient, actor: MailboxActor, lockAuthority = true): Promise<Mailbox> {
    const { rows: [box] } = await client.query<Mailbox>('select * from session_mailboxes where id=$1 and "userId"=$2 and "workspaceId"=$3' + (lockAuthority ? ' for no key update' : ''), [actor.mailboxId, actor.userId, this.workspaceId])
    if (!box || box.userId !== actor.userId || box.workspaceId !== this.workspaceId || !['run', 'coordinator', 'bot'].includes(box.kind) || actor.workspaceId !== this.workspaceId || box.disabled) throw new MailboxError('Mailbox unavailable')
    if (box.kind === 'bot' && !(await client.query('select 1 from bots where id=$1 and "ownerId"=$2 and "workspaceId"=$3' + (lockAuthority ? ' for share' : ''), [box.sessionKey, actor.userId, this.workspaceId])).rowCount) throw new MailboxError('Bot is no longer authorized')
    if (box.kind === 'run') {
      if (!actor.runId) throw new MailboxError('Run identity required')
      const { rows: [run] } = await client.query(`select r.status,r."stopRequestedAt",r."leaseExpiresAt",d.enabled from agent_runs r join devices d on d.id=r."deviceId" where r.id=$1 and r."mailboxId"=$2 and r."userId"=$3 and d."ownerId"=$3 ${lockAuthority ? 'for share of r,d' : ''}`, [actor.runId, box.id, actor.userId])
      if (!run || !LIVE.includes(run.status) || run.stopRequestedAt || !run.enabled || !liveLease(run.leaseExpiresAt)) throw new MailboxError('Run is no longer authorized')
    }
    if (lockAuthority && actor.runTokenHash && !(await client.query('select id from run_tokens where "runId"=$1 and "userId"=$2 and "tokenHash"=$3 and "revokedAt" is null and "expiresAt">clock_timestamp() for share', [actor.runId, actor.userId, actor.runTokenHash])).rowCount) throw new MailboxError('Run token is no longer authorized', 401)
    return box
  }
  async recipients(actor: MailboxActor) {
    return this.transaction(async client => {
      await this.authorize(client, actor)
      // No transcripts, role configuration or repository paths are disclosed.
      const { rows } = await client.query(`select id,kind,"sessionKey","latestRunId",disabled,"wakeBudget" from session_mailboxes where "userId"=$1 and "workspaceId"=$2 and kind in ('run','coordinator','bot') order by "createdAt",id limit 100`, [actor.userId, this.workspaceId])
      return { self: actor.mailboxId, recipients: rows }
    }, client => this.authorize(client, actor))
  }
  async send(actor: MailboxActor, input: { to: string; key: string; text: string; replyTo?: string }) {
    return this.sendEnvelope(actor, input, false)
  }
  /** Explicit owner action, never available to a run or peer tool. */
  async ownerSend(userId: string, input: { to: string; key: string; text: string; resume: boolean }) {
    if (input.resume) throw new MailboxError('Terminal resume is unavailable in the personal core', 409)
    const actor = await this.conversation(userId, 'coordinator')
    return this.sendEnvelope(actor, input, true)
  }
  /** A retry changes the transport address, not the identity of an outgoing operation.
   * Only persisted infrastructure-retry edges participate. No peer-supplied scope,
   * Agent-role grouping or ordinary continuation edge can join independent senders.
   */
  private async sendScope(client: PoolClient, actor: MailboxActor, box: Mailbox) {
    if (box.kind !== 'run') return { lock: `mailbox:${box.id}`, senders: [box.id] }
    type RunIdentity = { id: string; userId: string; issueId: string | null; agentId: string; kind: string; retryOf: string | null; mailboxId: string | null; status: string; stopReason: string | null; attempt: number }
    const read = async (id: string) => (await client.query<RunIdentity>('select * from agent_runs where id=$1 and "userId"=$2', [id, actor.userId])).rows[0]
    // A mailbox continuation deliberately keeps its original session identity.
    let root = await read(box.sessionKey)
    if (!root || root.mailboxId !== box.id || root.kind === 'group_review') throw new MailboxError('Invalid mailbox operation identity')
    const seen = new Set<string>()
    while (root.retryOf) {
      if (seen.has(root.id) || seen.size >= 64) throw new MailboxError('Invalid retry operation lineage')
      seen.add(root.id)
      const parent = await read(root.retryOf)
      if (!parent || parent.agentId !== root.agentId || parent.issueId !== root.issueId || !root.issueId
        || parent.kind !== root.kind || parent.status !== 'failed' || parent.stopReason !== 'device_lost'
        || root.attempt !== parent.attempt + 1) throw new MailboxError('Invalid retry operation lineage')
      if (parent.mailboxId) {
        const { rows: [parentBox] } = await client.query<Mailbox>('select * from session_mailboxes where id=$1', [parent.mailboxId])
        if (!parentBox || parentBox.userId !== actor.userId || parentBox.workspaceId !== actor.workspaceId || parentBox.kind !== 'run') throw new MailboxError('Retry mailbox scope mismatch')
        const initial = await read(parentBox.sessionKey)
        if (!initial || initial.mailboxId !== parentBox.id || initial.agentId !== parent.agentId || initial.issueId !== parent.issueId || initial.kind !== parent.kind) throw new MailboxError('Invalid retry mailbox identity')
        root = initial
      } else root = parent
    }
    // Historical envelopes remain at their original addresses. Include every
    // validated retry branch, so concurrent siblings cannot publish twice either.
    const { rows } = await client.query<{ mailboxId: string | null; workspaceId: string | null; mailboxOwner: string | null; disabled: boolean | null }>(`
      WITH RECURSIVE family AS (
        SELECT id,"userId","agentId","issueId",kind,status,"stopReason",attempt,"mailboxId"
        FROM agent_runs WHERE id=$1 AND "userId"=$2
        UNION
        SELECT r.id,r."userId",r."agentId",r."issueId",r.kind,r.status,r."stopReason",r.attempt,r."mailboxId"
        FROM agent_runs r JOIN family f ON
          (r."mailboxId"=f."mailboxId" OR
           (r."retryOf"=f.id AND f.status='failed' AND f."stopReason"='device_lost' AND r.attempt=f.attempt+1))
        WHERE r."userId"=f."userId" AND r."agentId"=f."agentId" AND r."issueId" IS NOT DISTINCT FROM f."issueId"
          AND r.kind=f.kind
      ) SELECT DISTINCT f."mailboxId",m."workspaceId",m."userId" AS "mailboxOwner",m.disabled
        FROM family f LEFT JOIN session_mailboxes m ON m.id=f."mailboxId"`, [root.id, actor.userId])
    if (rows.some(row => row.mailboxId && (row.workspaceId !== actor.workspaceId || row.mailboxOwner !== actor.userId))) throw new MailboxError('Retry mailbox scope mismatch')
    if (rows.some(row => row.disabled)) throw new MailboxError('Retry mailbox disabled')
    const senders = rows.flatMap(row => row.mailboxId ? [row.mailboxId] : [])
    if (!senders.includes(box.id)) throw new MailboxError('Invalid retry operation lineage')
    return { lock: `retry:${root.id}`, senders }
  }
  private async sendEnvelope(actor: MailboxActor, input: { to: string; key: string; text: string; replyTo?: string }, owner: boolean): Promise<MailboxReceipt> {
    return this.transaction<MailboxReceipt>(async client => {
      const box = await this.authorize(client, actor, false)
      let scope = await this.sendScope(client, actor, box)
      // Serialize this logical sender/key before selecting a recipient. The unique
      // index alone would turn cross-recipient races into an unhandled 23505.
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`${actor.workspaceId}:${actor.userId}:${scope.lock}:${input.key}`])
      // Serialize scheduling/policy writers without blocking FK KEY SHARE on
      // this address. Completion may hold the coordinator while referencing it.
      await client.query('select id from session_mailboxes where id=any($1::uuid[]) and "userId"=$2 and "workspaceId"=$3 order by id for no key update', [[actor.mailboxId, input.to], actor.userId, this.workspaceId])
      const { rows: [target] } = await client.query<Mailbox>('select * from session_mailboxes where id=$1 and "userId"=$2 and "workspaceId"=$3 for no key update' , [input.to, actor.userId, this.workspaceId])
      if (!target || target.userId !== actor.userId || target.workspaceId !== this.workspaceId || !['run', 'coordinator', 'bot'].includes(target.kind)) throw new MailboxError('Recipient unavailable')
      await this.authorize(client, actor)
      const refreshed = await this.sendScope(client, actor, box)
      if (refreshed.lock !== scope.lock) throw new MailboxError('Retry identity changed', 409)
      scope = refreshed
      const { rows: priors } = await client.query('select * from run_messages where "senderMailboxId"=any($1::uuid[]) and "dedupeKey"=$2', [scope.senders, input.key])
      // Do not hide or delete duplicates produced by older deployments.
      if (priors.length > 1) throw new MailboxError('Ambiguous historical retry delivery; reconciliation required', 409)
      const prior = priors[0]
      if (prior) {
        if (prior.mailboxId !== input.to || prior.text !== input.text || (prior.replyTo ?? undefined) !== input.replyTo || prior.origin !== (owner ? 'owner' : 'peer')) throw new MailboxError('Idempotency key already used for another message', 409)
        return { id: prior.id, queued: true, duplicate: true, failure: prior.failure }
      }
      if (input.replyTo && !(await client.query('select 1 from run_messages where id=$1 and "mailboxId"=any($2::uuid[]) and "senderMailboxId"=$3', [input.replyTo, scope.senders, target.id])).rowCount) throw new MailboxError('Reply is not to a message in this inbox')
      if (!input.text.trim() || input.text.length > 4000) throw new MailboxError('Message must be 1–4000 characters', 400)
      const id = randomUUID()
      const inserted = await client.query('insert into run_messages (id,"userId",text,"mailboxId","senderMailboxId","dedupeKey","replyTo",origin) values ($1,$2,$3,$4,$5,$6,$7,$8) returning "createdAt"', [id, actor.userId, input.text, target.id, actor.mailboxId, input.key, input.replyTo ?? null, owner ? 'owner' : 'peer'])
      if (target.disabled) await client.query('update run_messages set failure=$1 where id=$2', ['recipient_disabled', id])
      if (target.kind === 'coordinator' && !target.disabled) {
        await client.query(`insert into coordinator_events (id,"userId",kind,"dedupeKey","runId",payload,tier) values ($1,$2,$3,$4,$5,$6,'result')`, [randomUUID(), actor.userId, owner ? 'user_message' : 'run_report', `mailbox:${id}`, actor.runId ?? null, JSON.stringify({ text: owner ? input.text : personalPeerText({ id, senderMailboxId: actor.mailboxId, text: input.text, sourceRunId: actor.runId, createdAt: inserted.rows[0]?.createdAt }) })])
      }
      return { id, queued: true, duplicate: false, failure: target.disabled ? 'recipient_disabled' : null }
    }, client => this.authorize(client, actor))
  }
  async inbox(actor: MailboxActor) {
    return this.transaction(async client => {
      await this.authorize(client, actor)
      const { rows } = await client.query(`update run_messages set "deliveredAt"=coalesce("deliveredAt",now()) where "mailboxId"=$1 and "acknowledgedAt" is null and id in (select id from run_messages where "mailboxId"=$1 and "acknowledgedAt" is null order by sequence limit 50) returning id,"senderMailboxId",text,"replyTo",origin,sequence,"createdAt","deliveredAt","acknowledgedAt",failure`, [actor.mailboxId])
      rows.sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0)
      return { self: actor.mailboxId, messages: rows.map(presentPersonalInboxRow), instructions: PERSONAL_MESSAGE_INSTRUCTIONS, authority: 'Server-set origin distinguishes owner messages from peer data; neither bypasses run permissions' }
    }, client => this.authorize(client, actor))
  }
  async ack(actor: MailboxActor, ids: string[]) {
    return this.transaction(async client => {
      await this.authorize(client, actor)
      const { rows } = await client.query('update run_messages set "acknowledgedAt"=coalesce("acknowledgedAt",now()) where "mailboxId"=$1 and id=any($2::uuid[]) and "deliveredAt" is not null returning id', [actor.mailboxId, ids])
      return { acknowledged: rows.map(row => row.id) }
    }, client => this.authorize(client, actor))
  }
  async sent(actor: MailboxActor) {
    return this.transaction(async client => {
      await this.authorize(client, actor)
      const { rows } = await client.query('select id,"mailboxId","deliveredAt","acknowledgedAt",failure,sequence from run_messages where "senderMailboxId"=$1 order by sequence desc limit 50', [actor.mailboxId])
      return rows
    }, client => this.authorize(client, actor))
  }
  async ownerView(userId: string, id?: string) {
    const { rows: mailboxes } = await this.pool.query('select * from session_mailboxes where "userId"=$1 and "workspaceId"=$2 and kind<>\'group\' and ($3::uuid is null or id=$3) order by "createdAt",id limit 100', [userId, this.workspaceId, id ?? null])
    if (id && !mailboxes.length) throw new MailboxError('Mailbox unavailable', 404)
    const messages = id ? (await this.pool.query('select id,text,origin,"senderMailboxId","replyTo",sequence,"deliveredAt","acknowledgedAt",failure from run_messages where "mailboxId"=$1 order by sequence desc limit 100', [id])).rows : []
    return { mailboxes, messages }
  }
}
