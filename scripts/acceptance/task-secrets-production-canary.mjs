// Trusted acceptance runner only. No production value or database credential
// is sent to a task. Every mutation uses the ordinary signed-in human surface.
import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { UNFINISHED_RUN_STATUSES } from '../../lib/agent-run-statuses.ts'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/
const TERMINAL = ['succeeded', 'failed', 'stopped', 'cancelled']
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (value, code) => { if (!value) throw Error(`task_secrets_${code}`) }
const freshCanary = () => `mikka1712s_${randomBytes(32).toString('hex')}`

/** This is an operator-reserved window, not a database lock. The linked owner
 * coordination and a fresh full-owner read are both necessary; neither a
 * recent/limited task list nor a locally invented idle=true is evidence. */
export function canaryWindow(env, now = Date.now()) {
  let value
  try { value = JSON.parse(env.TASK_SECRETS_WINDOW ?? 'null') }
  catch (cause) { throw Error('task_secrets_canary_window', { cause }) }
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'comment,expiresAt', 'canary_window')
  const { comment, expiresAt } = value
  const deadline = Date.parse(expiresAt ?? '')
  check(/^https:\/\/github\.com\/alexj11324\/Mikka\/(?:issues|pull)\/1752#issuecomment-[0-9]+$/.test(comment ?? '')
    && typeof expiresAt === 'string' && Number.isFinite(deadline) && new Date(deadline).toISOString() === expiresAt
    && deadline > now + 30_000 && deadline <= now + 45 * 60_000, 'canary_window')
  return { comment, expiresAt }
}

export async function createOwnerIdleVerifier({ connectionString, ownerId, email, window, sourceCommit, fixtureId }, {
  Pool: PoolImpl, now = Date.now,
} = {}) {
  check(typeof connectionString === 'string' && connectionString.length > 0, 'canary_database_unavailable')
  check(typeof ownerId === 'string' && ownerId.length > 0 && typeof email === 'string' && email.includes('@')
    && SHA.test(sourceCommit ?? '') && UUID.test(fixtureId ?? ''), 'canary_scope')
  const Pool = PoolImpl ?? (await import('pg')).Pool
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000,
    application_name: 'mikka-1712-canary-readonly', options: '-c default_transaction_read_only=on' })
  let closed = false
  return {
    async assertIdle(allowedRunIds = []) {
      check(!closed && Array.isArray(allowedRunIds) && allowedRunIds.length <= 8
        && allowedRunIds.every(id => UUID.test(id)), 'canary_scope')
      const started = now()
      check(Date.parse(window.expiresAt) > started + 30_000, 'canary_window')
      const client = await pool.connect()
      let begun = false
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true
        await client.query("SET LOCAL statement_timeout = '5s'")
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'")
        const result = await client.query(`WITH active AS (
          SELECT id,status,"stopRequestedAt" FROM agent_runs WHERE "userId"=$1 AND NOT (status=ANY($4::text[]))
        ) SELECT
          (SELECT count(*)::int FROM "user" WHERE id=$1 AND lower(email)=lower($2)) AS "ownerMatches",
          count(*)::int AS "unfinishedCount",
          (count(*) FILTER (WHERE NOT (id=ANY($3::uuid[]))))::int AS "foreignCount",
          (count(*) FILTER (WHERE id=ANY($3::uuid[]) AND "stopRequestedAt" IS NOT NULL))::int AS "ownedStopRequestedCount",
          (count(*) FILTER (WHERE NOT (status=ANY($5::text[]))))::int AS "unknownStatusCount",
          current_setting('transaction_read_only') AS "readOnly"
        FROM active`, [ownerId, email, allowedRunIds, TERMINAL, [...UNFINISHED_RUN_STATUSES]])
        const row = result.rows?.[0]
        check(result.rows?.length === 1 && row?.readOnly === 'on' && row.ownerMatches === 1
          && ['unfinishedCount', 'foreignCount', 'unknownStatusCount', 'ownedStopRequestedCount'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)
          && row.unknownStatusCount === 0 && now() - started <= 10_000, 'canary_idle_unverified')
        await client.query('COMMIT'); begun = false
        check(Date.parse(window.expiresAt) > now() + 30_000, 'canary_window')
        const proof = { scope: 'all_owner_runs_all_workspaces_without_time_or_row_limit',
          ownerHash: hash(ownerId).slice(0, 16), sourceCommit, fixtureId,
          checkedAt: new Date(now()).toISOString(), windowComment: window.comment,
          unfinishedCount: row.unfinishedCount, ownedActiveCount: row.unfinishedCount - row.foreignCount,
          ownedStopRequestedCount: row.ownedStopRequestedCount,
          foreignActiveCount: row.foreignCount, readOnly: true, atomicWithMutation: false }
        check(row.foreignCount === 0, 'owner_busy')
        return proof
      } catch (cause) {
        if (begun) await client.query('ROLLBACK').catch(() => {})
        throw Error('task_secrets_canary_idle_unverified', { cause })
      } finally { client.release() }
    },
    async assertRevoked(runId, requestedAt) {
      check(!closed && UUID.test(runId ?? '') && Number.isFinite(Date.parse(requestedAt)), 'canary_scope')
      const client = await pool.connect()
      let begun = false
      try {
        await client.query('BEGIN READ ONLY'); begun = true
        await client.query("SET LOCAL statement_timeout = '5s'")
        const { rows } = await client.query(`SELECT status,"stopRequestedAt","leaseExpiresAt"
          FROM agent_runs WHERE id=$1 AND "userId"=$2`, [runId, ownerId])
        const row = rows?.[0], stoppedAt = new Date(row?.stopRequestedAt).getTime(), leaseUntil = new Date(row?.leaseExpiresAt).getTime()
        check(rows?.length === 1 && TERMINAL.includes(row?.status) && row.stopRequestedAt !== null && row.leaseExpiresAt !== null
          && Number.isFinite(stoppedAt) && Number.isFinite(leaseUntil) && stoppedAt >= Date.parse(requestedAt) - 5000
          && leaseUntil <= stoppedAt, 'canary_revocation')
        await client.query('COMMIT'); begun = false
        return { status: row.status, stopRequestedAt: new Date(stoppedAt).toISOString(),
          leaseExpiresAt: new Date(leaseUntil).toISOString(), stoppedAfterRotation: true, leaseExpired: true }
      } catch (cause) {
        if (begun) await client.query('ROLLBACK').catch(() => {})
        throw Error('task_secrets_canary_revocation', { cause })
      } finally { client.release() }
    },
    async close() { if (!closed) { closed = true; await pool.end() } },
  }
}

export function productionDelivery(upstreamOrigin, caseId) {
  const url = new URL(upstreamOrigin)
  check(url.protocol === 'https:' && url.origin === upstreamOrigin && !url.username && !url.password
    && /^[A-Za-z0-9.-]+\.(?:e2b\.app|e2b\.dev)$/.test(url.hostname) && UUID.test(caseId ?? ''), 'canary_scope')
  return { mode: 'protected', http: { origin: upstreamOrigin, header: 'authorization', prefix: 'Bearer ', rules: [
    ...['protected', 'echo', 'redirect'].map(operation => ({ method: 'GET', path: `/v1/${operation}/${caseId}`, match: 'exact' })),
    { method: 'POST', path: `/sdk/${caseId}/v1/chat/completions`, match: 'exact' },
  ] } }
}

/** Exactly one newly-created private entry per acceptance. The synthetic
 * value stays in this closure and the authenticated disposable upstream. The
 * journal contains only scoped IDs, hashes and mutation acknowledgements. */
export async function createProductionCanary({ client, ownerId, email, workspaceId, sourceCommit, fixtureId,
  window, connectionString, pin, persist = async () => {} }, {
  verifierFactory = createOwnerIdleVerifier, now = Date.now,
} = {}) {
  check(UUID.test(workspaceId ?? '') && UUID.test(fixtureId ?? '') && SHA.test(sourceCommit ?? ''), 'canary_scope')
  const verifier = await verifierFactory({ connectionString, ownerId, email, window, sourceCommit, fixtureId }, { now })
  const name = `ACCEPTANCE_1712_${fixtureId.replaceAll('-', '').toUpperCase()}`
  const note = `issue=1712 fixture=${fixtureId} source=${sourceCommit}`
  const evidence = { version: 1, fixtureId, sourceCommit, name, ownerHash: hash(ownerId).slice(0, 16),
    scope: 'personal', window, productionStoreMutated: false, writes: [], idleChecks: [],
    cleanup: { deleted: false, outcome: 'not_created' } }
  let id, value = freshCanary(), baseline, createAttempted = false, closed = false, valueConfirmed = true
  const save = async () => persist(structuredClone(evidence))
  const rows = async () => {
    const result = await client.json('/api/secrets/delivery?scope=personal')
    check(result.scope === 'personal' && Array.isArray(result.secrets)
      && result.secrets.every(row => UUID.test(row.id ?? '') && row.kind === 'secret')
      && new Set(result.secrets.map(row => row.id)).size === result.secrets.length, 'canary_metadata')
    return result.secrets
  }
  const owns = row => row && row.id === id && !baseline?.has(row.id) && row.name === name
    && row.note === note && row.kind === 'secret' && row.delivery?.mode === 'protected'
  const current = async () => {
    const row = (await rows()).find(row => row.id === id)
    check(owns(row), 'canary_scope')
    return row
  }
  const reconcile = async () => {
    if (!createAttempted || id) return
    const found = (await rows()).filter(row => row.name === name && row.note === note && !baseline.has(row.id))
    check(found.length <= 1, 'canary_scope')
    if (found.length) {
      id = found[0].id; check(owns(found[0]), 'canary_scope')
      evidence.id = id; evidence.cleanup = { deleted: false, outcome: 'pending', id }; await save()
    }
  }
  const mutate = async (operation, allowedRunIds, action) => {
    check(!closed, 'canary_scope')
    await pin()
    const proof = await verifier.assertIdle(allowedRunIds)
    check(proof.ownedActiveCount === allowedRunIds.length && proof.ownedStopRequestedCount === 0, 'canary_idle_unverified')
    evidence.idleChecks.push({ operation, ...proof })
    const write = { operation, requestedAt: new Date(now()).toISOString(), acknowledged: false }
    evidence.writes.push(write)
    // A lost HTTP reply is an unknown write, never evidence of no mutation.
    evidence.productionStoreMutated = true
    await save()
    const result = await action()
    write.acknowledged = true; write.acknowledgedAt = new Date(now()).toISOString(); await save()
    return result
  }
  return {
    evidence,
    async preflight() {
      await pin()
      const proof = await verifier.assertIdle([])
      evidence.idleChecks.push({ operation: 'preflight', ...proof }); await save()
      return proof
    },
    async open() {
      check(!createAttempted && !id, 'canary_scope')
      baseline = new Set((await rows()).map(row => row.id))
      check(!(await rows()).some(row => row.name === name), 'canary_scope')
      try {
        const result = await mutate('create', [], async () => {
          createAttempted = true
          return client.rpc('user-secrets.createMySecret', [{ name, kind: 'secret', value, note, overrideWorkspace: false }, workspaceId])
        })
        check(result?.ok === true && UUID.test(result.data?.id ?? ''), 'canary_metadata')
        id = result.data.id
        evidence.id = id; evidence.cleanup = { deleted: false, outcome: 'pending', id }; await save()
        await current()
      } catch (cause) {
        await reconcile()
        throw Error('task_secrets_canary_create', { cause })
      }
    },
    async prepareCase(fixture, caseId, phase) {
      check(['revocation', 'fresh_claim'].includes(phase) && UUID.test(caseId ?? '') && id && valueConfirmed, 'canary_scope')
      await current()
      const delivery = productionDelivery(fixture.upstreamOrigin, caseId)
      await mutate('policy', [], async () => {
        const result = await client.json('/api/secrets/delivery', { method: 'PATCH',
          headers: { origin: 'https://app.aspectlylabs.com', 'content-type': 'application/json' },
          body: JSON.stringify({ id, delivery }) })
        check(result.scope === 'personal' && owns(result.secret)
          && isDeepStrictEqual(result.secret.delivery, delivery), 'canary_metadata')
      })
      const state = await fixture.createProductionCase(caseId, value)
      check(state.canarySha256 === hash(value), 'canary_fixture')
      return { ...state, secretName: name, deliveryMode: 'production_claim', phase }
    },
    async rotate(runId) {
      check(UUID.test(runId ?? '') && id, 'canary_scope')
      await current()
      const next = freshCanary()
      const previousCanarySha256 = hash(value), requestedAt = new Date(now()).toISOString()
      await mutate('rotate', [runId], async () => {
        valueConfirmed = false
        const result = await client.rpc('user-secrets.replaceMySecret', [{ id, value: next }, workspaceId])
        check(result?.ok === true && owns(result.data), 'canary_metadata')
      })
      value = next; valueConfirmed = true
      return { requestedAt, rotatedAt: new Date(now()).toISOString(), secretId: id,
        previousCanarySha256, newCanarySha256: hash(value) }
    },
    verifyRevoked: (runId, requestedAt) => verifier.assertRevoked(runId, requestedAt),
    async close() {
      if (closed) return evidence.cleanup
      try {
        await reconcile()
        if (!id) {
          evidence.cleanup = { deleted: !createAttempted, outcome: createAttempted ? 'creation_unconfirmed' : 'not_created' }
          return evidence.cleanup
        }
        await current()
        await mutate('delete', [], async () => {
          const result = await client.rpc('user-secrets.deleteMySecret', [{ id }, workspaceId])
          check(result?.ok === true && result.data?.id === id, 'canary_metadata')
        })
        check(!(await rows()).some(row => row.id === id || row.name === name), 'canary_cleanup')
        evidence.cleanup = { deleted: true, id, outcome: 'exact_created_id_deleted_and_absence_verified' }
        return evidence.cleanup
      } catch (cause) {
        // A foreign active run/window expiry is a deferred exact-ID cleanup,
        // never permission to stop it or to delete any unrecorded entry.
        evidence.cleanup = { deleted: false, ...(id ? { id } : {}), name,
          outcome: 'deferred_requires_reserved_owner_window' }
        throw Error('task_secrets_canary_cleanup', { cause })
      } finally {
        closed = true; value = ''
        try { await save() } finally { await verifier.close() }
      }
    },
  }
}
