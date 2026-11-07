import { runChanged } from './live/panels'
import { serverRunFailure } from './run-failure-details'
import { CodedError } from '@mikka/protocol/coded-error'
import 'server-only'
import { freezeExecutionIdentity, revalidateExecutionIdentity } from './execution-identity'
import type { PoolClient } from 'pg'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { notifyDeviceWork } from '@/lib/device-gateway-notify'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { inDatabaseTransaction } from '@/lib/db/request-scope'
import { actAs } from '@/lib/acting-user'
import { actingContext } from '@/lib/activity-actor'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { borrowTaskWorkspaceMembership, withTaskWorkspace } from '@/lib/task-workspace'
import { agentRuns, issues } from '@/lib/db/schema'
import { apiKeyWorkerDefinition, retryWorkerDefinition, type WorkerDefinitionSnapshot } from '@/lib/agent-kit/worker'
import { workerDefinitionDigest } from '@/lib/agent-kit/worker-digest'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runCredentialSwitchedEvent, runQuotaPausedEvent, type QuotaApiKey, type QuotaSubscription } from '@/lib/coordinator-events'
import { quotaContinuationNote, quotaContinuationPrompt } from '@/lib/run-retry'
import { tiptapToText } from '@/lib/tiptap-text'
import type { RunApiKey } from '@/lib/run-credential-source'
import { runListChanged } from '@/lib/live/lists'

// A subscription's quota ran out mid-run: the daemon or hosted runner reports
// `quota_exhausted` (packages/daemon/src/runs/quota-exhausted.ts). When
// 「订阅额度用完后，自动改用 API Key」 is on and the person has a key for the
// run's Agent, the run goes on at once as a continuation frozen on that key
// (`retryOf` the original, same worktree, same session on the same device).
// Otherwise the run is paused (`pauseReason`='quota_exhausted', no lease) for
// the person: they add a key and resume on it, or retry with the original
// credential after the reset. Each outcome is one coordinator event.

type Run = typeof agentRuns.$inferSelect
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Query = Pick<PoolClient, 'query'>

/** These entry points own APP transactions. Resolve the immutable tenant with
 * a released APP read, then retain the authenticated caller's scope and proof
 * until all writes commit. A nested owner may borrow WS, never invert APP→WS. */
async function withQuotaRunWorkspace<T>(userId: string, runId: string, work: (workspaceId: string) => Promise<T>): Promise<T> {
  if (!z.uuid().safeParse(runId).success) throw new ActionFailureError('runNotFound')
  if (inDatabaseTransaction()) throw new ActionFailureError('executionAccountUnavailable')
  const { rows: [stored] } = await pool.query<{ workspaceId: string | null }>(
    'SELECT "workspaceId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId, userId])
  if (!stored) throw new ActionFailureError('runNotFound')
  if (!stored.workspaceId) throw new ActionFailureError('runInvalid')
  const workspaceId = stored.workspaceId
  const acting = actingContext.getStore()
  if (acting && (acting.userId !== userId || acting.tokenWorkspaceId && acting.tokenWorkspaceId !== workspaceId))
    throw new ActionFailureError('runNotFound')
  const reader = { id: userId, [tokenWorkspace]: workspaceId,
    ...(acting?.enterprisePrincipal ? { [enterprisePrincipal]: acting.enterprisePrincipal } : {}) }
  const run = () => actAs(reader, () => work(workspaceId), acting?.actor)
  const borrowed = borrowTaskWorkspaceMembership(userId, workspaceId)
  if (borrowed) {
    try { await borrowed.check(); return await run() }
    finally { await borrowed.close() }
  }
  return withTaskWorkspace(reader, workspaceId, run)
}

/** Where a run's continuation is queued: on its device directly, or through the cloud queue. */
type CloudBinding = { workspaceId: string; botId: string }

interface QuotaScope {
  from: QuotaSubscription
  harness: 'claude_code' | 'codex'
  cloud: CloudBinding | null
  botWorkspaceId: string | null
  choiceWorkspaceId: string | null
}

/** What the server does with a `quota_exhausted` run. Null: it was not on a subscription, so it is an ordinary error. */
export type QuotaPlan = QuotaScope & ({ key: QuotaApiKey; why?: never } | { key?: never; why: 'apiKeyAfterQuotaOff' | 'noApiKey' })

async function quotaScope(query: Query, run: Run): Promise<QuotaScope | null> {
  // A run already on an API key is never switched; its rate limit is an error.
  // Unattributed historical rows cannot gain execution through a quota retry.
  if (!run.agentDefinition || run.agentDefinition.apiKey || !run.workspaceId) return null
  const harness = run.agentDefinition.harness
  if (harness !== 'claude_code' && harness !== 'codex') return null
  const frozen = run.agentDefinition.executionIdentity
  if (frozen && frozen.workspaceId !== run.workspaceId) return null
  // Reuse the caller's APP executor. The immutable run tenant is authoritative;
  // task, Bot and optional cloud placement must agree with it.
  const { rows: [scope] } = await query.query<{
    workspaceId: string; taskWorkspaceId: string | null; ownershipState: string | null
    botWorkspaceId: string | null; cloudRunId: string | null; cloudWorkspaceId: string | null; cloudBotId: string | null
  }>(`SELECT r."workspaceId",i."workspaceId" AS "taskWorkspaceId",i."ownershipState",
      b."workspaceId" AS "botWorkspaceId",c."runId" AS "cloudRunId",c."workspaceId" AS "cloudWorkspaceId",c."botId" AS "cloudBotId"
    FROM agent_runs r LEFT JOIN issues i ON i.id=r."issueId"
    LEFT JOIN bots b ON b.id=r."botId" AND b."ownerId"=r."userId"
    LEFT JOIN computer_run_bindings c ON c."runId"=r.id AND c."ownerId"=r."userId"
    WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId"=$3
      AND r."issueId" IS NOT DISTINCT FROM $4::uuid AND r."botId" IS NOT DISTINCT FROM $5::uuid`,
  [run.id, run.userId, run.workspaceId, run.issueId, run.botId])
  if (!scope || (run.issueId && (scope.ownershipState !== 'bound' || scope.taskWorkspaceId !== scope.workspaceId))
    || (run.botId && scope.botWorkspaceId !== scope.workspaceId)
    || (scope.cloudRunId && (scope.cloudWorkspaceId !== scope.workspaceId || !scope.cloudBotId))) return null
  const pinned = run.agentDefinition.subscription?.bindingId ?? null
  const { rows: [binding] } = await query.query<{ connectionId: string }>(
    `SELECT b."connectionId" FROM byos_bindings b WHERE b."ownerId"=$2 AND b.id=COALESCE($3::uuid,(SELECT n."bindingId" FROM byos_native_runs n WHERE n."runId"=$1))`,
    [run.id, run.userId, pinned])
  return { from: { provider: harness === 'codex' ? 'codex' : 'claude', connectionId: binding?.connectionId ?? null }, harness,
    cloud: scope.cloudRunId ? { workspaceId: scope.workspaceId, botId: scope.cloudBotId! } : null,
    botWorkspaceId: run.botId ? scope.workspaceId : null, choiceWorkspaceId: scope.workspaceId }
}

async function quotaKey(query: Query, run: Run, scope: QuotaScope): Promise<QuotaApiKey | undefined> {
  const { quotaFallbackApiKey } = await import('@/lib/run-credential-source')
  const model = run.agentDefinition?.cliModelSelection === 'explicit' ? run.agentDefinition.model : run.agentDefinition?.subscription?.modelId
  const key = await quotaFallbackApiKey(query, { ownerId: run.userId, botId: run.botId, harness: scope.harness, model,
    botWorkspaceId: scope.botWorkspaceId, choiceWorkspaceId: scope.choiceWorkspaceId })
  if (!key) return undefined
  const { rows: [row] } = await query.query<{ provider: string; name: string | null; last4: string }>('SELECT provider,name,last4 FROM model_api_keys WHERE id=$1', [key.keyId])
  return row && { keyId: key.keyId, provider: row.provider, name: row.name, last4: row.last4, model: key.model }
}

/** Read in the completion transaction: the setting, then the key the run would go on with. */
export async function planQuotaExhausted(query: Query, run: Run): Promise<QuotaPlan | null> {
  const scope = await quotaScope(query, run)
  if (!scope) return null
  const { apiKeyAfterQuota } = await import('@/lib/model-api-keys')
  if (!(await apiKeyAfterQuota(query, run.userId))) return { ...scope, why: 'apiKeyAfterQuotaOff' }
  const key = await quotaKey(query, run, scope)
  return key ? { ...scope, key } : { ...scope, why: 'noApiKey' }
}

/** The continuation's definition: on the key, or (null key) on the run's own credential. */
async function continuationDefinition(run: Run, prompt: string, key: RunApiKey | null, queued?: Run): Promise<WorkerDefinitionSnapshot | null> {
  if (!run.workspaceId || (queued && queued.workspaceId !== run.workspaceId)) throw new ActionFailureError('executionAccountUnavailable')
  const snapshot = run.agentDefinition!
  await revalidateExecutionIdentity(pool, run)
  const definition = key ? apiKeyWorkerDefinition(snapshot, prompt, key) : retryWorkerDefinition(snapshot, prompt)
  if (definition) {
    // Cloud continuations are queued on the Bot's parent device before a new child is provisioned.
    // Copy standing instructions from the source, but retain the new host-admitted placement.
    if (queued) {
      delete definition.repositoryAdmission
      if (queued.agentDefinition?.repositoryAdmission) definition.repositoryAdmission = structuredClone(queued.agentDefinition.repositoryAdmission)
      if (definition.allowLocalRecovery && !queued.agentDefinition?.allowLocalRecovery) {
        delete definition.allowLocalRecovery
        definition.definitionDigest = workerDefinitionDigest(definition)
      }
    }
    definition.executionIdentity = await freezeExecutionIdentity(pool, { ...(queued ?? run), agentDefinition: definition }, undefined, run.workspaceId)
    const current = definition.executionIdentity
    if (current.workspaceId !== run.workspaceId) throw new ActionFailureError('executionAccountUnavailable')
    if (snapshot.executionIdentity && (current.requester !== snapshot.executionIdentity.requester || current.executionPrincipal !== snapshot.executionIdentity.executionPrincipal || current.outputOwner !== snapshot.executionIdentity.outputOwner || current.botId !== snapshot.executionIdentity.botId || current.botOwner !== snapshot.executionIdentity.botOwner || current.workspaceId !== snapshot.executionIdentity.workspaceId)) throw new ActionFailureError('executionAccountUnavailable')
  }
  return definition
}

/** A device run's continuation, in the caller's transaction, after the original ended. */
async function queueDeviceContinuation(tx: Tx, run: Run, key: RunApiKey | null): Promise<string> {
  const id = crypto.randomUUID()
  const prompt = quotaContinuationPrompt(run.prompt)
  await tx.insert(agentRuns).values({
    id, userId: run.userId, workspaceId: run.workspaceId, issueId: run.issueId, agentId: run.agentId, botId: run.botId, source: run.source,
    agentDefinition: await continuationDefinition(run, prompt, key), deviceId: run.deviceId, deviceRepoId: run.deviceRepoId,
    status: 'queued', kind: run.kind, baseBranch: run.baseBranch, prompt, attempt: run.attempt, retryOf: run.id,
  })
  await runListChanged(tx, id)
  await runChanged(tx, id)
  return id
}

/** A cloud run's continuation goes through the cloud queue (like a lost run's), keyed so a repeat finds the same run. */
export async function queueCloudQuotaContinuation(hint: Run, cloud: CloudBinding, key: RunApiKey | null): Promise<string> {
  if (!hint.workspaceId || cloud.workspaceId !== hint.workspaceId) throw new ActionFailureError('executionAccountUnavailable')
  return withQuotaRunWorkspace(hint.userId, hint.id, async workspaceId => {
    if (workspaceId !== hint.workspaceId || workspaceId !== cloud.workspaceId) throw new ActionFailureError('executionAccountUnavailable')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await withDatabaseClient(client, async () => {
        // Match cloud/Factory cancellation order before freezing the source.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${workspaceId}`])
        const { rows: [request] } = await client.query<{ sourceEventId: string }>(`SELECT t."sourceEventId" FROM factory_tasks t
          JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
          WHERE t."userId"=$1 AND a."runId"=$2 AND t."workspaceId"=$3 FOR UPDATE OF t`, [hint.userId, hint.id, workspaceId])
        const locked = await lockPaused(db, hint.userId, hint.id, workspaceId)
        if ('continuation' in locked) return locked.continuation
        const run = locked.run
        const scope = await quotaScope(client, run)
        if (!scope?.cloud || scope.cloud.workspaceId !== workspaceId || scope.cloud.botId !== cloud.botId)
          throw new ActionFailureError('executionAccountUnavailable')
        // A queued cloud child commits before its paused parent is settled.
        // Opposing resume modes must still return that one existing child.
        const [prior] = await db.select({ id: agentRuns.id }).from(agentRuns)
          .where(and(eq(agentRuns.retryOf, run.id), eq(agentRuns.userId, run.userId), eq(agentRuns.workspaceId, workspaceId)))
          .orderBy(asc(agentRuns.createdAt)).limit(1)
        if (prior) return prior.id
        if (!run.issueId || !run.deviceRepoId) throw new ActionFailureError('runInvalid')
        const [issue] = await db.select({ title: issues.title, content: issues.content }).from(issues)
          .where(and(eq(issues.id, run.issueId), eq(issues.workspaceId, workspaceId), eq(issues.ownershipState, 'bound'))).limit(1)
        if (!issue) throw new ActionFailureError('issueNotFound')
        const [{ queueCloudRun }, { threadRunModel }] = await Promise.all([import('@/lib/computer/queue-run'), import('@/lib/computer/run-model')])
        const actor = { userId: run.userId, workspaceId }
        const { rows: [target] } = await pool.query(`SELECT runtime."agentId",runtime."repoId",a."deviceId",repo."remoteUrl"
          FROM bot_cloud_runtimes runtime JOIN agents a ON a.id=runtime."agentId" JOIN device_repos repo ON repo.id=$4 AND repo."userId"=$2
          WHERE runtime."botId"=$1 AND runtime."ownerId"=$2 AND runtime.harness=$3`, [cloud.botId, run.userId, run.agentDefinition!.harness, run.deviceRepoId])
        if (!target) throw new ActionFailureError('runInvalid')
        const repoId = target.remoteUrl ? (await (await import('@/lib/device-repositories')).ensureDeviceRepository(run.userId, target.deviceId, target.remoteUrl, client)).id : target.repoId
        const { runId } = await queueCloudRun(pool, actor, { botId: cloud.botId, issueId: run.issueId, agentId: target.agentId, deviceRepoId: repoId, readOnly: run.agentDefinition?.readOnly, title: issue.title, body: tiptapToText(issue.content),
          allowLocalRecovery: run.agentDefinition?.allowLocalRecovery, sourceEventId: run.agentDefinition?.allowLocalRecovery ? request?.sourceEventId : undefined,
          note: quotaContinuationNote(), withoutBot: run.botId === null, idempotencyKey: `quota:${run.id}:${key ? 'api_key' : 'original'}`, threadRunId: run.id,
          // Preserve the selected model and credential; tenant admission grants neither.
          ...(key ? { apiKey: key, model: key.model } : { ...threadRunModel(run.agentDefinition), model: run.agentDefinition?.model ?? '' }) }, client)
        const [queued] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, run.userId), eq(agentRuns.workspaceId, workspaceId))).limit(1)
        if (!queued) throw new ActionFailureError('runNotFound')
        await db.update(agentRuns).set({ retryOf: run.id, attempt: run.attempt, kind: run.kind, baseBranch: run.baseBranch,
          agentDefinition: await continuationDefinition(run, queued.prompt, key, queued), updatedAt: new Date() }).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, run.userId), eq(agentRuns.workspaceId, workspaceId)))
        await runListChanged(client, runId)
        await runChanged(client, runId)
        return runId
      })
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  })
}

/** Ends a quota-paused run once its continuation exists; false when something else ended it first. */
async function endPausedRun(tx: Tx, runId: string, userId: string, workspaceId: string): Promise<Run | undefined> {
  const [ended] = await tx.update(agentRuns).set({ status: 'failed', pauseReason: null, failureDetails: serverRunFailure(runId, new Date(), new CodedError('run_quota_exceeded')), finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId), eq(agentRuns.workspaceId, workspaceId), eq(agentRuns.status, 'paused'), eq(agentRuns.pauseReason, 'quota_exhausted'))).returning()
  if (ended) { await runListChanged(tx, runId); await runChanged(tx, runId) }
  return ended
}

/**
 * In the completion transaction, after the run row was written: the device
 * run's continuation and the event. A cloud run with a key returns `cloud`:
 * its continuation is queued after commit (`continueCloudQuotaRun`).
 */
export async function settleQuotaExhausted(tx: Tx, run: Run, plan: QuotaPlan, resetsAt: string | null): Promise<{ cloud: boolean; deviceId?: string | null }> {
  if (plan.key && plan.cloud) return { cloud: true }
  if (plan.key) {
    const retryRunId = await queueDeviceContinuation(tx, run, plan.key)
    await recordCoordinatorEvent(tx, runCredentialSwitchedEvent(run, plan.from, plan.key, retryRunId, resetsAt))
    return { cloud: false, deviceId: run.deviceId }
  }
  await recordCoordinatorEvent(tx, runQuotaPausedEvent(run, plan.from, resetsAt, plan.why))
  return { cloud: false }
}

/** After the completion commit: a paused cloud run goes on with its key, or stays paused with its card. */
export async function continueCloudQuotaRun(run: Run, plan: QuotaPlan, resetsAt: string | null) {
  if (!plan.key || !plan.cloud) return
  const key = plan.key, cloud = plan.cloud
  try {
    await withQuotaRunWorkspace(run.userId, run.id, async workspaceId => {
      if (run.workspaceId !== workspaceId || cloud.workspaceId !== workspaceId) throw new ActionFailureError('executionAccountUnavailable')
      try {
        const retryRunId = await queueCloudQuotaContinuation(run, cloud, key)
        await db.transaction(async tx => {
          const ended = await endPausedRun(tx, run.id, run.userId, workspaceId)
          if (ended) await recordCoordinatorEvent(tx, runCredentialSwitchedEvent(ended, plan.from, key, retryRunId, resetsAt))
        })
        await (await import('@/lib/run-completion-effects')).afterRunEnded(run.userId, run.id)
        await (await import('@/lib/run-leases')).startThreadMachine({ userId: run.userId, workspaceId }, retryRunId)
      } catch {
        // A genuine queue failure keeps the existing paused card. Recheck its
        // locked source; a denied tenant or a stopped run creates no new event.
        const client = await pool.connect()
        try {
          await withDatabaseClient(client, () => db.transaction(async tx => {
            const locked = await lockPaused(tx, run.userId, run.id, workspaceId)
            if ('continuation' in locked) return
            const current = await quotaScope(client, locked.run)
            if (!current?.cloud || current.cloud.workspaceId !== workspaceId || current.cloud.botId !== cloud.botId) return
            await recordCoordinatorEvent(tx, runQuotaPausedEvent(locked.run, current.from, resetsAt, 'noApiKey'))
          }))
        } finally { client.release() }
      }
    })
  } catch (error) {
    if (!(error instanceof ActionFailureError) || !['workspaceAccessDenied', 'runNotFound', 'runNotActive', 'runInvalid', 'executionAccountUnavailable'].includes(error.code)) throw error
  }
}

/** The run, locked, when it is the owner's and paused on its quota; else its existing continuation, or an error. */
async function lockPaused(tx: Pick<Tx, 'select' | 'execute'>, userId: string, runId: string, workspaceId: string): Promise<{ run: Run } | { continuation: string }> {
  const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId), eq(agentRuns.workspaceId, workspaceId))).for('update')
  if (!run) throw new ActionFailureError('runNotFound')
  if (run.status === 'paused' && run.pauseReason === 'quota_exhausted') return { run }
  // Already resumed or retried: the same answer again.
  const [next] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.retryOf, runId), eq(agentRuns.userId, userId), eq(agentRuns.workspaceId, workspaceId))).orderBy(asc(agentRuns.createdAt)).limit(1)
  if (next && run.stopReason === 'quota_exhausted') return { continuation: next.id }
  if (run.stopReason === 'quota_exhausted') {
    const { sql } = await import('drizzle-orm')
    const eventId = (await import('@/lib/factory/event-id')).factoryEventId('quota-check-continuation',run.id)
    const receipt = await tx.execute(sql`SELECT child.id FROM factory_events e JOIN factory_tasks t ON t.id=e."taskId" JOIN agent_runs child ON child.id::text=e.result->>'runId' AND child."userId"=t."userId" AND child."workspaceId"=t."workspaceId" WHERE t."userId"=${userId} AND t."workspaceId"=${workspaceId}::uuid AND e."eventId"=${eventId}::uuid`)
    if (receipt.rows[0]?.id) return { continuation: String(receipt.rows[0].id) }
  }
  throw new ActionFailureError('runNotActive')
}

/**
 * Goes on with a quota-paused run: `apiKey` on the person's key (after they
 * added one; emits `run_credential_switched`), `original` with the run's own
 * subscription or login (if the quota is still out, it pauses again).
 * Owner only; a repeat returns the continuation already queued.
 */
async function continuePausedRun(userId: string, runId: string, mode: 'apiKey' | 'original'): Promise<{ runId: string }> {
  return withQuotaRunWorkspace(userId, runId, async workspaceId => {
  const client = await pool.connect()
  let cloud: { run: Run; plan: QuotaScope; key: QuotaApiKey | null } | null = null
  let result: { runId: string } | null = null
  let wake: string | null | undefined
  try {
    await withDatabaseClient(client, () => db.transaction(async tx => {
      const locked = await lockPaused(tx, userId, runId, workspaceId)
      if ('continuation' in locked) { result = { runId: locked.continuation }; return }
      const { run } = locked
      const scope = await quotaScope(client, run)
      if (!scope) throw new ActionFailureError('runInvalid')
      const key = mode === 'apiKey' ? await quotaKey(client, run, scope) ?? null : null
      if (mode === 'apiKey' && !key) throw new ActionFailureError('apiKeyNotFound')
      if (scope.cloud) { cloud = { run, plan: scope, key }; return }
      if (!await endPausedRun(tx, run.id, userId, workspaceId)) throw new ActionFailureError('runNotActive')
      const retryRunId = await queueDeviceContinuation(tx, run, key)
      if (key) await recordCoordinatorEvent(tx, runCredentialSwitchedEvent(run, scope.from, key, retryRunId, run.quotaResetsAt?.toISOString() ?? null))
      wake = run.deviceId
      result = { runId: retryRunId }
    }))
  } finally { client.release() }
  if (wake) notifyDeviceWork(wake)
  if (result) return afterContinue(userId, result)
  const pending = cloud as { run: Run; plan: QuotaScope; key: QuotaApiKey | null } | null
  if (!pending) throw new ActionFailureError('runNotActive')
  let retryRunId: string
  try { retryRunId = await queueCloudQuotaContinuation(pending.run, pending.plan.cloud!, pending.key) }
  catch (error) { if (error instanceof ActionFailureError) throw error; throw new ActionFailureError('runInvalid') }
  await db.transaction(async tx => {
    const ended = await endPausedRun(tx, pending.run.id, userId, workspaceId)
    if (ended && pending.key)
      await recordCoordinatorEvent(tx, runCredentialSwitchedEvent(ended, pending.plan.from, pending.key, retryRunId, ended.quotaResetsAt?.toISOString() ?? null))
  })
  await (await import('@/lib/run-completion-effects')).afterRunEnded(userId, pending.run.id)
  await (await import('@/lib/run-leases')).startThreadMachine({ userId, workspaceId: pending.plan.cloud!.workspaceId }, retryRunId)
  return afterContinue(userId, { runId: retryRunId })
  })
}

async function afterContinue(userId: string, result: { runId: string }) {
  const [next] = await db.select({ retryOf: agentRuns.retryOf }).from(agentRuns).where(and(eq(agentRuns.id, result.runId),eq(agentRuns.userId,userId))).limit(1)
  if (next?.retryOf) await (await import('@/lib/run-completion-effects')).afterRunEnded(userId, next.retryOf)
  const { wakeCoordinator } = await import('@/lib/coordinator/wake')
  await wakeCoordinator(userId).catch(() => undefined)
  return result
}

/** For the quota card: resume a quota-paused run on the person's key, after they added one. */
export function resumeQuotaPausedRunOnApiKey(userId: string, runId: string) {
  return continuePausedRun(userId, runId, 'apiKey')
}

/** For the quota card: retry a quota-paused run with its original credential (after the reset). */
export function retryQuotaPausedRun(userId: string, runId: string) {
  return continuePausedRun(userId, runId, 'original')
}

/** For the quota card: whether a key the paused run could go on with exists now (added since it paused). */
export async function quotaKeyReady(query: Query, run: Run): Promise<boolean> {
  const scope = await quotaScope(query, run)
  return Boolean(scope && await quotaKey(query, run, scope))
}
