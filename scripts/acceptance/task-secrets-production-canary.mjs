// Trusted acceptance runner only. No production value or database credential
// is sent to a task. Every mutation uses the ordinary signed-in human surface.
import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { UNFINISHED_RUN_STATUSES } from '../../lib/agent-run-statuses.ts'
import { sanitizeTraceContext, telemetryId } from '../../packages/protocol/src/trace-context.ts'
import { collectTaskSecretEvidence } from './task-secrets-evidence.mjs'

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
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000,
    application_name: 'mikka-1712-canary-readonly', options: '-c default_transaction_read_only=on' })
  let closed = false
  // Private to this verifier/collector. Each query commits and releases before
  // owner HTTP begins. Cancellation destroys an in-flight or late connection;
  // no transaction or unbounded pool checkout survives the evidence deadline.
  async function readOnlyQuery(text, values, { signal, timeoutMs }, isolation = 'read_committed') {
    check(!closed && signal instanceof AbortSignal && !signal.aborted
      && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5000
      && ['read_committed', 'repeatable_read'].includes(isolation), 'canary_object_evidence')
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    const until = Date.now() + timeoutMs
    let connection, released = false, abortListener
    const release = destroy => { if (connection && !released) { released = true; connection.release(destroy) } }
    const cancelled = new Promise((_, reject) => {
      abortListener = () => { release(true); reject(Error('task_secrets_canary_object_evidence')) }
      deadline.addEventListener('abort', abortListener, { once: true })
      if (deadline.aborted) abortListener()
    })
    const work = (async () => {
      let begun = false, failed = true
      const step = (statement, parameters) => {
        check(!deadline.aborted && Date.now() < until, 'canary_object_evidence')
        return connection.query({ text: statement, values: parameters,
          query_timeout: Math.max(1, Math.min(timeoutMs, until - Date.now())) })
      }
      try {
        connection = await pool.connect()
        check(!deadline.aborted, 'canary_object_evidence')
        await step(isolation === 'repeatable_read' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN READ ONLY'); begun = true
        await step("SELECT set_config('statement_timeout',$1,true),set_config('idle_in_transaction_session_timeout',$1,true)", [`${Math.max(1, until - Date.now())}ms`])
        const result = await step(text, values)
        check(!deadline.aborted, 'canary_object_evidence')
        await step('COMMIT'); begun = false; failed = false
        return result
      } catch (cause) {
        if (begun && !released && !deadline.aborted) {
          try { await step('ROLLBACK') } catch { /* Destroy below; preserve the original query failure. */ }
        }
        throw cause
      } finally { release(failed || deadline.aborted) }
    })()
    try { return await Promise.race([work, cancelled]) }
    catch (cause) { throw Error('task_secrets_canary_object_evidence', { cause }) }
    finally { deadline.removeEventListener('abort', abortListener) }
  }
  return {
    async collectObjects({ client, scope, canaries, budget, saveObject }) {
      check(!closed && scope?.ownerId === ownerId, 'canary_scope')
      return collectTaskSecretEvidence({ query: (text, values, control) => {
        check(values[0] === ownerId, 'canary_scope'); return readOnlyQuery(text, values, control)
      }, client, scope, canaries, budget, saveObject })
    },
    async assertIdle(allowedRunIds = [], control) {
      check(!closed && Array.isArray(allowedRunIds) && allowedRunIds.length <= 8
        && allowedRunIds.every(id => UUID.test(id)), 'canary_scope')
      const started = now()
      check(Date.parse(window.expiresAt) > started + 30_000, 'canary_window')
      try {
        const result = await readOnlyQuery(`WITH active AS (
          SELECT id,status,"stopRequestedAt" FROM agent_runs WHERE "userId"=$1 AND NOT (status=ANY($4::text[]))
        ) SELECT
          (SELECT count(*)::int FROM "user" WHERE id=$1 AND lower(email)=lower($2)) AS "ownerMatches",
          count(*)::int AS "unfinishedCount",
          (count(*) FILTER (WHERE NOT (id=ANY($3::uuid[]))))::int AS "foreignCount",
          (count(*) FILTER (WHERE id=ANY($3::uuid[]) AND "stopRequestedAt" IS NOT NULL))::int AS "ownedStopRequestedCount",
          (count(*) FILTER (WHERE NOT (status=ANY($5::text[]))))::int AS "unknownStatusCount",
          current_setting('transaction_read_only') AS "readOnly"
        FROM active`, [ownerId, email, allowedRunIds, TERMINAL, [...UNFINISHED_RUN_STATUSES]], control, 'repeatable_read')
        const row = result.rows?.[0]
        check(result.rows?.length === 1 && row?.readOnly === 'on' && row.ownerMatches === 1
          && ['unfinishedCount', 'foreignCount', 'unknownStatusCount', 'ownedStopRequestedCount'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)
          && row.unknownStatusCount === 0 && now() - started <= 10_000, 'canary_idle_unverified')
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
        throw Error('task_secrets_canary_idle_unverified', { cause })
      }
    },
    async assertRevoked(runId, requestedAt, control) {
      check(!closed && UUID.test(runId ?? '') && Number.isFinite(Date.parse(requestedAt)), 'canary_scope')
      try {
        const { rows } = await readOnlyQuery(`SELECT status,"stopRequestedAt","leaseExpiresAt"
          FROM agent_runs WHERE id=$1 AND "userId"=$2`, [runId, ownerId], control)
        const row = rows?.[0], stoppedAt = new Date(row?.stopRequestedAt).getTime(), leaseUntil = new Date(row?.leaseExpiresAt).getTime()
        check(rows?.length === 1 && TERMINAL.includes(row?.status) && row.stopRequestedAt !== null && row.leaseExpiresAt !== null
          && Number.isFinite(stoppedAt) && Number.isFinite(leaseUntil) && stoppedAt >= Date.parse(requestedAt) - 5000
          && leaseUntil <= stoppedAt, 'canary_revocation')
        return { status: row.status, stopRequestedAt: new Date(stoppedAt).toISOString(),
          leaseExpiresAt: new Date(leaseUntil).toISOString(), stoppedAfterRotation: true, leaseExpired: true }
      } catch (cause) {
        throw Error('task_secrets_canary_revocation', { cause })
      }
    },
    async readRunEvidence({ runId, issueId, workspaceId, botId }, control) {
      check(!closed && [runId, issueId, workspaceId, botId].every(value => UUID.test(value ?? '')), 'canary_scope')
      try {
        const { rows } = await readOnlyQuery(`SELECT r.id,r."issueId",r."workspaceId",r."botId",r.status,r."sessionId",
          r."createdAt",r."startedAt",r."finishedAt",r."stopRequestedAt",
          jsonb_build_object('traceparent',r."agentDefinition"#>>'{traceContext,traceparent}',
            'runId',r."agentDefinition"#>>'{traceContext,runId}',
            'threadId',r."agentDefinition"#>>'{traceContext,threadId}',
            'taskId',r."agentDefinition"#>>'{traceContext,taskId}',
            'workflowRunId',r."agentDefinition"#>>'{traceContext,workflowRunId}') AS trace
          FROM agent_runs r JOIN issues i ON i.id=r."issueId"
          WHERE r.id=$1 AND r."userId"=$2 AND r."issueId"=$3 AND r."workspaceId"=$4 AND r."botId"=$5
            AND i."userId"=$2 AND i."workspaceId"=$4 AND i."ownershipState"='bound'`, [runId, ownerId, issueId, workspaceId, botId], control)
        check(rows.length === 1 && rows[0].id === runId && rows[0].issueId === issueId
          && rows[0].workspaceId === workspaceId && rows[0].botId === botId
          && [...TERMINAL, ...UNFINISHED_RUN_STATUSES].includes(rows[0].status), 'canary_scope')
        const row = rows[0], trace = sanitizeTraceContext(Object.fromEntries(
          ['traceparent', 'runId', 'threadId', 'taskId', 'workflowRunId'].map(key => [key, row.trace?.[key]])))
        check(!trace || (!trace.runId || trace.runId === runId) && (!trace.taskId || trace.taskId === issueId), 'canary_scope')
        const times = {}
        for (const name of ['createdAt', 'startedAt', 'finishedAt', 'stopRequestedAt']) {
          const value = row[name] === null ? null : new Date(row[name])
          check(value === null || Number.isFinite(value.getTime()), 'canary_scope')
          times[name] = value?.toISOString() ?? null
        }
        return { runId, issueId, workspaceId, botId: UUID.test(row.botId ?? '') ? row.botId : null,
          status: row.status, observedAt: new Date(now()).toISOString(), ...times,
          harnessSessionId: telemetryId(row.sessionId) ? row.sessionId : null,
          persistedTrace: trace ? { status: 'recorded', traceId: trace.traceparent.slice(3, 35), ...trace }
            : { status: 'missing', reason: 'no_valid_persisted_trace_context' } }
      } catch (cause) {
        throw Error('task_secrets_canary_run_evidence', { cause })
      }
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
  window, connectionString, pin, persist = async () => {}, recovery, budget }, {
  verifierFactory = createOwnerIdleVerifier, now = Date.now,
} = {}) {
  check(UUID.test(workspaceId ?? '') && UUID.test(fixtureId ?? '') && SHA.test(sourceCommit ?? '')
    && typeof budget?.signal === 'function' && typeof budget?.remaining === 'function', 'canary_scope')
  const name = `ACCEPTANCE_1712_${fixtureId.replaceAll('-', '').toUpperCase()}`
  const note = `issue=1712 fixture=${fixtureId} source=${sourceCommit}`
  if (recovery) check(recovery.version === 1 && recovery.fixtureId === fixtureId && recovery.sourceCommit === sourceCommit
    && recovery.name === name && recovery.ownerHash === hash(ownerId).slice(0, 16)
    && recovery.scope === 'personal' && isDeepStrictEqual(recovery.window, window)
    && Array.isArray(recovery.writes) && Array.isArray(recovery.generations) && Array.isArray(recovery.cases)
    && recovery.baselineNameAbsent === true && (!recovery.id || UUID.test(recovery.id)), 'canary_scope')
  const verifier = await verifierFactory({ connectionString, ownerId, email, window, sourceCommit, fixtureId }, { now })
  const evidence = recovery ? structuredClone(recovery) : { version: 1, fixtureId, sourceCommit, name, ownerHash: hash(ownerId).slice(0, 16),
    scope: 'personal', window, productionStoreMutated: false, writes: [], idleChecks: [],
    generations: [], cases: [], cleanup: { deleted: false, outcome: 'not_created' } }
  let id = recovery?.id, value = recovery ? '' : freshCanary(), baseline,
    createAttempted = Boolean(recovery?.writes.some(write => write.operation === 'create')), closed = false, valueConfirmed = !recovery
  const save = async () => persist(structuredClone(evidence))
  const control = phase => ({ signal: budget.signal(phase), timeoutMs: budget.remaining(phase, 5000) })
  const generation = async (secret, operation, runId) => {
    const item = { generation: evidence.generations.length + 1, sha256: hash(secret), operation,
      format: 'synthetic_task_secret_v1', byteLength: 75, encodings: ['utf8'],
      state: 'prepared', preparedAt: new Date(now()).toISOString(), ...(runId ? { runId } : {}) }
    evidence.generations.push(item); await save(); return item
  }
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
    const found = (await rows()).filter(row => row.name === name && row.note === note && !baseline?.has(row.id))
    check(found.length <= 1, 'canary_scope')
    if (found.length) {
      id = found[0].id; check(owns(found[0]), 'canary_scope')
      evidence.id = id; evidence.cleanup = { deleted: false, outcome: 'pending', id }; await save()
    }
  }
  const mutate = async (operation, allowedRunIds, action, material, phase) => {
    check(!closed, 'canary_scope')
    await pin()
    const proof = await verifier.assertIdle(allowedRunIds, control(phase))
    check(proof.ownedActiveCount === allowedRunIds.length && proof.ownedStopRequestedCount === 0, 'canary_idle_unverified')
    evidence.idleChecks.push({ operation, ...proof })
    const write = { operation, requestedAt: new Date(now()).toISOString(), acknowledged: false }
    if (material) { material.state = 'requested'; material.requestedAt = write.requestedAt; write.generation = material.generation }
    evidence.writes.push(write)
    // A lost HTTP reply is an unknown write, never evidence of no mutation.
    evidence.productionStoreMutated = true
    await save()
    let result
    try { result = await action() }
    catch (cause) {
      if (material) { material.state = 'outcome_unknown'; material.observedAt = new Date(now()).toISOString() }
      try { await save() } catch (persistenceCause) {
        write.journalFailed = true
        throw new AggregateError([cause, persistenceCause], 'task_secrets_journal', { cause })
      }
      throw cause
    }
    write.acknowledged = true; write.acknowledgedAt = new Date(now()).toISOString()
    if (material) { material.state = 'acknowledged'; material.acknowledgedAt = write.acknowledgedAt }
    await save()
    return result
  }
  return {
    evidence,
    async preflight() {
      await pin()
      const proof = await verifier.assertIdle([], control())
      evidence.idleChecks.push({ operation: 'preflight', ...proof }); await save()
      return proof
    },
    async open() {
      check(!recovery && !createAttempted && !id, 'canary_scope')
      baseline = new Set((await rows()).map(row => row.id))
      check(!(await rows()).some(row => row.name === name), 'canary_scope')
      evidence.baselineNameAbsent = true; evidence.baselineCheckedAt = new Date(now()).toISOString()
      const material = await generation(value, 'create')
      try {
        const result = await mutate('create', [], async () => {
          createAttempted = true
          return client.rpc('user-secrets.createMySecret', [{ name, kind: 'secret', value, note, overrideWorkspace: false }, workspaceId])
        }, material)
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
      check(!recovery && ['revocation', 'fresh_claim'].includes(phase) && UUID.test(caseId ?? '') && id && valueConfirmed
        && evidence.cases.length < 4 && !evidence.cases.some(item => item.caseId === caseId), 'canary_scope')
      await current()
      const material = evidence.generations.at(-1)
      check(material?.state === 'acknowledged' && material.sha256 === hash(value), 'canary_scope')
      evidence.cases.push({ caseId, phase, generation: material.generation, sha256: material.sha256, preparedAt: new Date(now()).toISOString() })
      await save()
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
      check(!recovery && UUID.test(runId ?? '') && id && evidence.generations.length < 3, 'canary_scope')
      await current()
      const next = freshCanary()
      const previousCanarySha256 = hash(value), requestedAt = new Date(now()).toISOString()
      const material = await generation(next, 'rotate', runId)
      await mutate('rotate', [runId], async () => {
        valueConfirmed = false
        const result = await client.rpc('user-secrets.replaceMySecret', [{ id, value: next }, workspaceId])
        check(result?.ok === true && owns(result.data), 'canary_metadata')
      }, material)
      value = next; valueConfirmed = true
      return { requestedAt, rotatedAt: new Date(now()).toISOString(), secretId: id,
        previousCanarySha256, newCanarySha256: hash(value) }
    },
    verifyRevoked: (runId, requestedAt) => verifier.assertRevoked(runId, requestedAt, control()),
    async observeRun({ caseId, runId, issueId, botId }, { budget, phase = 'evidence' }) {
      const item = evidence.cases.find(value => value.caseId === caseId)
      check(item && (!item.runId || item.runId === runId), 'canary_scope')
      const observed = await verifier.readRunEvidence({ runId, issueId, workspaceId, botId },
        { signal: budget.signal(phase), timeoutMs: budget.remaining(phase, 5000) })
      item.runId = runId; item.issueId = issueId; item.botId = botId; item.lastObservedAt = observed.observedAt
      item.runEvidence = observed; await save(); return observed
    },
    async collectObjects({ caseId, runId, issueId, botId }, { budget, saveObject }) {
      const item = evidence.cases.find(entry => entry.caseId === caseId), observed = item?.runEvidence
      check(!closed && item?.runId === runId && item.issueId === issueId && item.botId === botId
        && observed?.runId === runId && observed.issueId === issueId && observed.botId === botId
        && observed.workspaceId === workspaceId && TERMINAL.includes(observed.status), 'canary_scope')
      check(evidence.generations.length > 0 && evidence.generations.every(entry => entry.format === 'synthetic_task_secret_v1'
        && entry.byteLength === 75 && isDeepStrictEqual(entry.encodings, ['utf8'])), 'canary_scope')
      return verifier.collectObjects({ client, scope: { ownerId, workspaceId, botId, issueId, runId }, budget, saveObject,
        canaries: { descriptor: { format: 'synthetic_task_secret_v1', byteLength: 75, encodings: ['utf8'] },
          // All currently generated material, including unknown writes. Later
          // rotations are not backdated into an earlier case's scan receipt.
          generations: structuredClone(evidence.generations) } })
    },
    async close() {
      if (closed) return evidence.cleanup
      try {
        await reconcile()
        if (!id) {
          evidence.cleanup = { deleted: !createAttempted, outcome: createAttempted ? 'creation_unconfirmed' : 'not_created' }
          return evidence.cleanup
        }
        if (recovery) {
          const currentRows = await rows()
          if (!currentRows.some(row => row.id === id || row.name === name)) {
            evidence.cleanup = { deleted: true, id, outcome: 'exact_created_id_absence_verified' }
            return evidence.cleanup
          }
        }
        await current()
        await mutate('delete', [], async () => {
          const result = await client.rpc('user-secrets.deleteMySecret', [{ id }, workspaceId])
          check(result?.ok === true && result.data?.id === id, 'canary_metadata')
        }, undefined, 'cleanup')
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
