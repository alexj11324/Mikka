import 'server-only'
import type { PoolClient } from 'pg'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { agentRuns, issues } from '@/lib/db/schema'
import { apiKeyWorkerDefinition, retryWorkerDefinition, type WorkerDefinitionSnapshot } from '@/lib/agent-kit/worker'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runCredentialSwitchedEvent, runQuotaPausedEvent, type QuotaApiKey, type QuotaSubscription } from '@/lib/coordinator-events'
import { quotaContinuationNote, quotaContinuationPrompt } from '@/lib/run-retry'
import { tiptapToText } from '@/lib/tiptap-text'
import type { RunApiKey } from '@/lib/run-credential-source'

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
  // Old rows without a frozen definition cannot carry a key either.
  if (!run.agentDefinition || run.agentDefinition.apiKey) return null
  const harness = run.agentDefinition.harness
  if (harness !== 'claude_code' && harness !== 'codex') return null
  const pinned = run.agentDefinition.subscription?.bindingId ?? null
  const { rows: [binding] } = await query.query<{ connectionId: string }>(
    `SELECT b."connectionId" FROM byos_bindings b WHERE b."ownerId"=$2 AND b.id=COALESCE($3::uuid,(SELECT n."bindingId" FROM byos_native_runs n WHERE n."runId"=$1))`,
    [run.id, run.userId, pinned])
  const { rows: [cloud] } = await query.query<CloudBinding>('SELECT "workspaceId","botId" FROM computer_run_bindings WHERE "runId"=$1 AND "ownerId"=$2', [run.id, run.userId])
  const botWorkspaceId = run.botId
    ? (await query.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2', [run.botId, run.userId])).rows[0]?.workspaceId ?? null
    : null
  const choiceWorkspaceId = botWorkspaceId ?? cloud?.workspaceId
    ?? await (await import('@/lib/execution-settings')).executionWorkspace(run.userId, null).catch(() => null)
  return { from: { provider: harness === 'codex' ? 'codex' : 'claude', connectionId: binding?.connectionId ?? null }, harness, cloud: cloud ?? null, botWorkspaceId, choiceWorkspaceId }
}

async function quotaKey(query: Query, run: Run, scope: QuotaScope): Promise<QuotaApiKey | undefined> {
  const { quotaFallbackApiKey } = await import('@/lib/run-credential-source')
  const key = await quotaFallbackApiKey(query, { ownerId: run.userId, botId: run.botId, harness: scope.harness, model: run.agentDefinition?.cliModelSelection === 'explicit' ? run.agentDefinition.model : undefined,
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
function continuationDefinition(snapshot: WorkerDefinitionSnapshot, prompt: string, key: RunApiKey | null): WorkerDefinitionSnapshot | null {
  return key ? apiKeyWorkerDefinition(snapshot, prompt, key) : retryWorkerDefinition(snapshot, prompt)
}

/** A device run's continuation, in the caller's transaction, after the original ended. */
async function queueDeviceContinuation(tx: Tx, run: Run, key: RunApiKey | null): Promise<string> {
  const id = crypto.randomUUID()
  const prompt = quotaContinuationPrompt(run.prompt)
  await tx.insert(agentRuns).values({
    id, userId: run.userId, issueId: run.issueId, agentId: run.agentId, botId: run.botId, source: run.source,
    agentDefinition: continuationDefinition(run.agentDefinition!, prompt, key), deviceId: run.deviceId, deviceRepoId: run.deviceRepoId,
    status: 'queued', kind: run.kind, baseBranch: run.baseBranch, prompt, attempt: run.attempt, retryOf: run.id,
  })
  return id
}

/** A cloud run's continuation goes through the cloud queue (like a lost run's), keyed so a repeat finds the same run. */
async function queueCloudContinuation(run: Run, cloud: CloudBinding, key: RunApiKey | null): Promise<string> {
  if (!run.issueId || !run.deviceRepoId) throw new ActionFailureError('runInvalid')
  const [issue] = await db.select({ title: issues.title, content: issues.content }).from(issues).where(eq(issues.id, run.issueId)).limit(1)
  if (!issue) throw new ActionFailureError('issueNotFound')
  const { queueCloudRun } = await import('@/lib/computer/queue-run')
  const actor = { userId: run.userId, workspaceId: cloud.workspaceId }
  const { runId } = await queueCloudRun(pool, actor, { botId: cloud.botId, issueId: run.issueId, agentId: run.agentId, deviceRepoId: run.deviceRepoId, title: issue.title, body: tiptapToText(issue.content),
    note: quotaContinuationNote(), withoutBot: run.botId === null, idempotencyKey: `quota:${run.id}:${key ? 'api_key' : 'original'}`,
    ...(key ? { apiKey: key } : run.agentDefinition?.model ? { model: run.agentDefinition.model } : {}) })
  await db.update(agentRuns).set({ retryOf: run.id, attempt: run.attempt, updatedAt: new Date() }).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, run.userId)))
  await (await import('@/lib/run-leases')).startThreadMachine(actor, runId)
  return runId
}

/** Ends a quota-paused run once its continuation exists; false when something else ended it first. */
async function endPausedRun(tx: Tx, runId: string, userId: string): Promise<boolean> {
  const [ended] = await tx.update(agentRuns).set({ status: 'failed', pauseReason: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId), eq(agentRuns.status, 'paused'), eq(agentRuns.pauseReason, 'quota_exhausted'))).returning({ id: agentRuns.id })
  return Boolean(ended)
}

/**
 * In the completion transaction, after the run row was written: the device
 * run's continuation and the event. A cloud run with a key returns `cloud`:
 * its continuation is queued after commit (`continueCloudQuotaRun`).
 */
export async function settleQuotaExhausted(tx: Tx, run: Run, plan: QuotaPlan, resetsAt: string | null): Promise<{ cloud: boolean }> {
  if (plan.key && plan.cloud) return { cloud: true }
  if (plan.key) {
    const retryRunId = await queueDeviceContinuation(tx, run, plan.key)
    await recordCoordinatorEvent(tx, runCredentialSwitchedEvent(run, plan.from, plan.key, retryRunId, resetsAt))
  } else await recordCoordinatorEvent(tx, runQuotaPausedEvent(run, plan.from, resetsAt, plan.why))
  return { cloud: false }
}

/** After the completion commit: a paused cloud run goes on with its key, or stays paused with its card. */
export async function continueCloudQuotaRun(run: Run, plan: QuotaPlan, resetsAt: string | null) {
  if (!plan.key || !plan.cloud) return
  try {
    const retryRunId = await queueCloudContinuation(run, plan.cloud, plan.key)
    await db.transaction(async tx => {
      if (await endPausedRun(tx, run.id, run.userId)) await recordCoordinatorEvent(tx, runCredentialSwitchedEvent(run, plan.from, plan.key, retryRunId, resetsAt))
    })
  } catch {
    // The cloud refused the continuation: the run stays paused, and the person can resume it on the key.
    await recordCoordinatorEvent(db, runQuotaPausedEvent(run, plan.from, resetsAt, 'noApiKey'))
  }
}

/** The run, locked, when it is the owner's and paused on its quota; else its existing continuation, or an error. */
async function lockPaused(tx: Tx, userId: string, runId: string): Promise<{ run: Run } | { continuation: string }> {
  const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId))).for('update')
  if (!run) throw new ActionFailureError('runNotFound')
  if (run.status === 'paused' && run.pauseReason === 'quota_exhausted') return { run }
  // Already resumed or retried: the same answer again.
  const [next] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.retryOf, runId), eq(agentRuns.userId, userId))).orderBy(asc(agentRuns.createdAt)).limit(1)
  if (next && run.stopReason === 'quota_exhausted') return { continuation: next.id }
  throw new ActionFailureError('runNotActive')
}

/**
 * Goes on with a quota-paused run: `apiKey` on the person's key (after they
 * added one; emits `run_credential_switched`), `original` with the run's own
 * subscription or login (if the quota is still out, it pauses again).
 * Owner only; a repeat returns the continuation already queued.
 */
async function continuePausedRun(userId: string, runId: string, mode: 'apiKey' | 'original'): Promise<{ runId: string }> {
  if (!z.uuid().safeParse(runId).success) throw new ActionFailureError('runNotFound')
  const client = await pool.connect()
  let cloud: { run: Run; plan: QuotaScope; key: QuotaApiKey | null } | null = null
  let result: { runId: string } | null = null
  try {
    await withDatabaseClient(client, () => db.transaction(async tx => {
      const locked = await lockPaused(tx, userId, runId)
      if ('continuation' in locked) { result = { runId: locked.continuation }; return }
      const { run } = locked
      const scope = await quotaScope(client, run)
      if (!scope) throw new ActionFailureError('runInvalid')
      const key = mode === 'apiKey' ? await quotaKey(client, run, scope) ?? null : null
      if (mode === 'apiKey' && !key) throw new ActionFailureError('apiKeyNotFound')
      if (scope.cloud) { cloud = { run, plan: scope, key }; return }
      if (!await endPausedRun(tx, run.id, userId)) throw new ActionFailureError('runNotActive')
      const retryRunId = await queueDeviceContinuation(tx, run, key)
      if (key) await recordCoordinatorEvent(tx, runCredentialSwitchedEvent(run, scope.from, key, retryRunId, run.quotaResetsAt?.toISOString() ?? null))
      result = { runId: retryRunId }
    }))
  } finally { client.release() }
  if (result) return afterContinue(userId, result)
  const pending = cloud as { run: Run; plan: QuotaScope; key: QuotaApiKey | null } | null
  if (!pending) throw new ActionFailureError('runNotActive')
  let retryRunId: string
  try { retryRunId = await queueCloudContinuation(pending.run, pending.plan.cloud!, pending.key) }
  catch (error) { if (error instanceof ActionFailureError) throw error; throw new ActionFailureError('runInvalid') }
  await db.transaction(async tx => {
    if (await endPausedRun(tx, pending.run.id, userId) && pending.key)
      await recordCoordinatorEvent(tx, runCredentialSwitchedEvent(pending.run, pending.plan.from, pending.key, retryRunId, pending.run.quotaResetsAt?.toISOString() ?? null))
  })
  return afterContinue(userId, { runId: retryRunId })
}

async function afterContinue(userId: string, result: { runId: string }) {
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
