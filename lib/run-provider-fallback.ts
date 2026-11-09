import 'server-only'
import { runListChanged } from './live/lists'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { providerFailureSchema, type ProviderFailure } from '@mikka/protocol/provider-failure'
import { emptyRunReport, runReport, type RunCompleteRequest } from '@mikka/protocol/run'
import type { RunPolicy } from '@mikka/protocol/agent-policy'
import type { agentRuns } from './db/schema'
import { withDatabaseClient } from './db'
import type { WorkerDefinitionSnapshot } from './agent-kit/worker'
import { workerDefinitionDigest } from './agent-kit/worker-digest'
import { digest } from './agent-kit/definition'
import { executionIdentitySchema, freezeExecutionIdentity, type ExecutionIdentity } from './execution-identity'
import { entryKey, type OrderEntry, type SkippedEntry } from './model-order-plan'
import { credentialStates, dispatchOrder, orderCandidates, readOrder } from './model-order'
import { bindAgentToConnection, modelUnavailableCard, resolveModelDispatch, type ModelDispatch } from './model-dispatch'
import type { ModelRoutingSnapshot } from './model-routing'
import { modelFallbackRecordSchema, type ModelFallbackChoice, type ModelFallbackRecord } from './run-model-fallback-view'
import { lockFactoryCompletionTasks } from './run-completion-effects'
import { lockCliAgentPolicy, lockCliTaskScope, providerContinuationPolicy } from './agent-tool-approval/policy-store'
import { intersectRunPolicy } from './run-assignment-policy'
import { providerContinuationPrompt } from './run-retry'
import { recordCoordinatorEvent } from './coordinator-event-store'
import { runFinishedEvent } from './coordinator-events'
import { defaultAgentCopy } from './agent-copy'
import { ActionFailureError } from './action-error'
import { ComputerError } from './computer/store'
import { runChanged } from './live/panels'
import { assertRunProjectResources, isProjectExecutionRefusal, withRunProjectExecution, withRunProjectResources } from './project-resources/run-lease'

type Run = typeof agentRuns.$inferSelect
type Query = Pick<Pool | PoolClient, 'query'>
type Scope = { ownerId: string; workspaceId: string; botId: string | null }
type Continuation = { runId: string; previousRunId: string; deviceId: string; cloud: boolean; workspaceId: string }
// JSONB cannot store NUL separators used by the in-memory dispatch key.
const attemptKey = (entry: OrderEntry) => encodeURIComponent(entryKey(entry))
const choice = (entry: OrderEntry): ModelFallbackChoice => ({ harness: entry.harness, model: entry.model, source: entry.source.kind })
const record = (run: Run): ModelFallbackRecord | undefined => {
  const value = modelFallbackRecordSchema.safeParse((run.report as Record<string, unknown> | null)?.modelFallback)
  return value.success ? value.data : undefined
}

/** Only an explicit runtime provider boundary can enter this path. Model/tool
 * text and arbitrary error summaries are deliberately not classified here. */
export function providerCompletion(run: Run, completion: RunCompleteRequest): RunCompleteRequest {
  const parsed = providerFailureSchema.safeParse(completion.report?.providerFailure)
  if (!run.stopRequestedAt && parsed.success && completion.stopReason === 'provider_failure') return completion
  // New preference-aware subscription runs use the same ordered fallback for
  // quota exhaustion. Historical runs retain their existing quota behavior.
  if (!run.stopRequestedAt && completion.stopReason === 'quota_exhausted' && run.agentDefinition?.modelDispatch && run.agentDefinition.subscription)
    return { ...completion, stopReason: 'provider_failure', report: { ...(completion.report ?? emptyRunReport()),
      providerFailure: { kind: 'balance', retryable: false, code: 'insufficient_quota' } } }
  const report = completion.report ? { ...completion.report } : undefined
  if (report) { delete report.providerFailure; delete report.providerCheckpoint }
  return { ...completion, ...(report ? { report } : {}),
    stopReason: completion.stopReason === 'provider_failure' ? run.stopRequestedAt ? 'cancelled' : 'error' : completion.stopReason }
}

/** Host-owned receipt; never accept this field from the worker's report. */
export function pendingProviderFallback(run: Run, failure: ProviderFailure): ModelFallbackRecord {
  const definition = run.agentDefinition
  const harness = definition?.harness === 'codex' ? 'codex' : 'claude_code'
  return { state: 'pending', fallback: failure.kind === 'balance' ? 'balance' : 'unavailable',
    from: { harness, model: definition?.model || 'unknown', source: definition?.apiKey ? 'api_key' : 'subscription' },
    attempted: definition?.modelDispatch?.entry ? [attemptKey(definition.modelDispatch.entry)] : [] }
}

const standingIdentity = (identity: ExecutionIdentity) => ({ requester: identity.requester, botId: identity.botId, botOwner: identity.botOwner,
  executionPrincipal: identity.executionPrincipal, workspaceId: identity.workspaceId, outputOwner: identity.outputOwner,
  personalResourcePolicy: identity.personalResourcePolicy, mcp: identity.resourceBindings.filter(binding => binding.kind === 'mcp') })

/** Preserve the original brief/standing tools and permissions, taking only the
 * newly admitted model, credential, placement and repository receipt. */
export function providerContinuationDefinition(source: WorkerDefinitionSnapshot, admitted: WorkerDefinitionSnapshot, prompt: string, policyCeiling?: RunPolicy): WorkerDefinitionSnapshot {
  const { apiKey: _key, subscription: _subscription, executionIdentity: _identity, repositoryAdmission: _admission,
    allowLocalRecovery: _local, profileOriginRunId: _profileOrigin, ...standing } = structuredClone(source)
  const { routing: _previousRouting, ...dispatch } = source.modelDispatch!
  const definition: WorkerDefinitionSnapshot = { ...standing, harness: admitted.harness, model: admitted.model,
    modelSource: admitted.modelSource, cliModelSelection: 'explicit', promptDigest: digest(prompt),
    ...(source.agentProfile && admitted.modelDispatch?.entry ? { agentProfile: { ...structuredClone(source.agentProfile), targetEntry: structuredClone(admitted.modelDispatch.entry) } } : {}),
    ...(policyCeiling ? { policyCeiling: source.policyCeiling ? intersectRunPolicy(policyCeiling, source.policyCeiling) : policyCeiling } : {}),
    modelDispatch: { ...dispatch, mode: 'preference', entry: admitted.modelDispatch?.entry,
      ...(admitted.modelDispatch?.routing ? { routing: structuredClone(admitted.modelDispatch.routing) } : {}) },
    ...(admitted.apiKey ? { apiKey: admitted.apiKey } : {}), ...(admitted.subscription ? { subscription: admitted.subscription } : {}),
    ...(admitted.repositoryAdmission ? { repositoryAdmission: admitted.repositoryAdmission } : {}),
    ...(source.allowLocalRecovery && admitted.allowLocalRecovery ? { allowLocalRecovery: true } : {}) }
  definition.definitionDigest = workerDefinitionDigest(definition)
  return definition
}

/** Factory accepts changed models only with the committed host receipt and an
 * otherwise unchanged standing definition and requester/workspace identity. */
export function providerContinuationMatches(prior: Run, next: Run): boolean {
  const receipt = record(prior), before = prior.agentDefinition, after = next.agentDefinition
  if (prior.stopReason !== 'provider_failure' || prior.stopRequestedAt || !before || !after || before.modelDispatch?.mode !== 'preference' ||
    receipt?.state !== 'switched' || receipt.retryRunId !== next.id || receipt.nextDefinitionDigest !== after.definitionDigest ||
    next.retryOf !== prior.id || next.userId !== prior.userId || next.botId !== prior.botId || next.issueId !== prior.issueId ||
    !after.modelDispatch?.entry || !isDeepStrictEqual(receipt.to, choice(after.modelDispatch.entry)) ||
    (before.pinnedDeviceId && before.pinnedDeviceId !== next.deviceId) || after.modelDispatch.mode !== 'preference') return false
  const first = executionIdentitySchema.safeParse(before.executionIdentity), second = executionIdentitySchema.safeParse(after.executionIdentity)
  if (!first.success || !second.success || !isDeepStrictEqual(standingIdentity(first.data), standingIdentity(second.data))) return false
  const { executionIdentity: _identity, ...actual } = after
  return isDeepStrictEqual(actual, providerContinuationDefinition(before, after, next.prompt, after.policyCeiling))
}

/** Independent Factory checks intentionally discard the failed native session
 * and continuation prompt. Only their exact current host adoption event can
 * authorize that transformation; the worker cannot supply this receipt. */
export async function providerContinuationLaunchMatches(query: Query, prior: Run, next: Run): Promise<boolean> {
  if (await (await import('./factory/candidate-recheck')).candidateRecheckPinsRun(query, prior.userId, prior.id)) return false
  if (providerContinuationMatches(prior, next)) return true
  const definition = next.agentDefinition
  if (next.retryOf !== null || !definition || next.prompt !== prior.prompt || definition.promptDigest !== digest(prior.prompt) ||
    (next.status === 'queued' && next.sessionId !== null) || (next.sessionId && next.sessionId === prior.sessionId)) return false
  const prompt = providerContinuationPrompt(prior.prompt)
  if (!providerContinuationMatches(prior, { ...next, retryOf: prior.id, prompt,
    agentDefinition: { ...definition, promptDigest: digest(prompt) } })) return false
  const { factoryEventId } = await import('./factory/event-id')
  const { rowCount } = await query.query(`SELECT 1 FROM factory_tasks t
    JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id AND a.stage=t.stage
    JOIN factory_attempts previous ON previous."taskId"=t.id AND previous."runId"=$1 AND previous.stage=a.stage AND previous.status='failed'
    JOIN factory_events e ON e."taskId"=t.id AND e."eventId"=$4
    WHERE t."userId"=$3 AND t."issueId"=$5 AND t.status='running' AND t.stage IN ('review','verify','monitor')
      AND a."runId"=$2 AND a.output->>'requestEpoch'=t."sourceEventId"::text
      AND previous.output->>'requestEpoch'=t."sourceEventId"::text
      AND a."candidateId" IS NOT DISTINCT FROM t."candidateId" AND previous."candidateId" IS NOT DISTINCT FROM t."candidateId"
      AND e.request->>'priorRunId'=$1::text AND e.result->>'runId'=$2::text`,
    [prior.id, next.id, prior.userId, factoryEventId('provider-check-continuation', prior.id), prior.issueId])
  return Boolean(rowCount)
}

async function readSource(query: Query, userId: string, runId: string) {
  return (await query.query<Run>('SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId, userId])).rows[0]
}

async function fallbackScope(query: Query, run: Run): Promise<Scope> {
  const { rows: [scope] } = await query.query<{ workspaceId: string; botId: string | null }>(`SELECT COALESCE(
      $3::text, b."workspaceId"::text, cb."workspaceId"::text) AS "workspaceId",COALESCE(r."botId",cb."botId") AS "botId"
    FROM agent_runs r LEFT JOIN bots b ON b.id=r."botId" LEFT JOIN computer_run_bindings cb ON cb."runId"=r.id AND cb."ownerId"=r."userId"
    WHERE r.id=$1 AND r."userId"=$2`, [run.id, run.userId, run.agentDefinition?.executionIdentity?.workspaceId ?? null])
  return { ownerId: run.userId, workspaceId: scope?.workspaceId ?? await (await import('./execution-settings')).executionWorkspace(run.userId, run.botId), botId: scope?.botId ?? run.botId }
}

async function attemptedEntries(query: Query, run: Run, entries: OrderEntry[], smartRouting: boolean): Promise<Set<string>> {
  // A bounded recursive chain is owner/task scoped and contains only earlier
  // provider continuations; old tasks cannot exhaust this task's order.
  const { rows } = await query.query<{ report: unknown; entry: OrderEntry | null }>(`WITH RECURSIVE chain AS (
    SELECT r.id,r."retryOf",r.report,r."agentDefinition",0 AS depth FROM agent_runs r WHERE r.id=$1 AND r."userId"=$2
    UNION ALL SELECT p.id,p."retryOf",p.report,p."agentDefinition",c.depth+1 FROM chain c JOIN agent_runs p ON p.id=c."retryOf"
      WHERE p."userId"=$2 AND p."issueId" IS NOT DISTINCT FROM $3::uuid AND p."botId" IS NOT DISTINCT FROM $4::uuid
        AND p."stopReason"='provider_failure' AND c.depth<128)
    SELECT report,"agentDefinition"->'modelDispatch'->'entry' AS entry FROM chain`, [run.id, run.userId, run.issueId, run.botId])
  const attempted = new Set<string>()
  for (const row of rows) {
    const receipt = modelFallbackRecordSchema.safeParse((row.report as Record<string, unknown> | null)?.modelFallback)
    if (receipt.success) for (const key of receipt.data.attempted ?? []) attempted.add(key)
    if (row.entry) attempted.add(attemptKey(row.entry))
  }
  const current = run.agentDefinition?.modelDispatch?.entry
  const index = current ? entries.findIndex(entry => attemptKey(entry) === attemptKey(current)) : -1
  // Difficulty routing may deliberately start later in the preference list.
  // Earlier, stronger entries have not been attempted by that run.
  if (!smartRouting || !run.agentDefinition?.modelDispatch?.routing)
    for (const entry of entries.slice(0, index + 1)) attempted.add(attemptKey(entry))
  return attempted
}

function reasonLine(reason: string): string {
  const copy = defaultAgentCopy
  return ({ balance: copy.needsModelBalance, providerUnavailable: copy.needsModelProviderUnavailable,
    keyRefused: copy.needsModelKeyRefused, expired: copy.needsModelKeyRefused, alreadyTried: copy.needsModelAlreadyTried,
    checking: copy.needsModelChecking, noDevice: copy.needsModelNoDevice, cloudNotConfigured: copy.needsModelCloud,
    cloudModelsUnknown: copy.needsModelCloudModelsUnknown, cloudModelNotReported: copy.needsModelCloudModelNotReported,
  } as Record<string, string>)[reason] ?? copy.needsModelUnavailable
}

async function unavailableRecord(pool: Pool, scope: Scope, run: Run, attempted: Set<string>, skipped: SkippedEntry[] = [], ownerPinned = false): Promise<ModelFallbackRecord> {
  const candidates = await orderCandidates(pool, scope), { entries } = await readOrder(pool, scope, candidates)
  const states = await credentialStates(pool, scope, entries, candidates, undefined, { probe: false })
  const receipt = record(run) ?? pendingProviderFallback(run, providerFailureSchema.parse(run.report?.providerFailure))
  const picked = ownerPinned || run.agentDefinition?.modelDispatch?.mode !== 'preference'
  const failure = providerFailureSchema.parse(run.report?.providerFailure)
  // An explicit pick never probes the rest of the order. Its card can explain
  // that model's failure, but cannot claim healthy, untried models have no place.
  const reasons = picked ? [{ choice: receipt.from, reason: failure.kind === 'balance' ? 'balance'
    : failure.kind === 'auth' ? receipt.from.source === 'subscription' ? 'expired' : 'keyRefused' : 'providerUnavailable' }] : entries.map(entry => {
    const state = states.get(entry.id)?.credential
    const reason = state && !state.usable ? state.reason : skipped.find(item => attemptKey(item.entry) === attemptKey(entry))?.block.reason
      ?? (attempted.has(attemptKey(entry)) ? 'alreadyTried' : 'noDevice')
    return { choice: choice(entry), reason }
  })
  const card = modelUnavailableCard('unavailable')
  card.description = [picked ? defaultAgentCopy.needsModelPinned : card.description,
    ...reasons.map(item => `${item.choice.harness === 'codex' ? 'Codex' : 'Claude Code'} · ${item.choice.model}：${reasonLine(item.reason)}`)].join('\n')
  return { ...receipt, state: picked ? 'picked' : 'blocked', attempted: [...attempted], card, reasons }
}

/** Serialize recovery after its immutable completion, with the same lock order
 * as admission/Factory. A worker replay can safely finish an interrupted handoff. */
async function settle(pool: Pool, original: Run, receipt: ModelFallbackRecord, target?: {
  agentId: string; deviceId: string; deviceRepoId: string; model: string; entry: OrderEntry;
  routing?: ModelRoutingSnapshot;
  subscriptionBindingId?: string; cloud: boolean; botId: string | null; workspaceId: string;
}): Promise<Continuation | null> {
  if (!original.workspaceId) throw new ActionFailureError('executionAccountUnavailable')
  const { withProjectResourceLease } = await import('./project-resources/store')
  return withProjectResourceLease(original.userId, original.workspaceId, async () => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (target && original.issueId) {
      const task = await lockCliTaskScope(client, original.userId, original.issueId)
      for (const agentId of [...new Set([original.agentId, target.agentId].filter((id): id is string => Boolean(id)))].sort())
        await lockCliAgentPolicy(client, original.userId, agentId, original.botId, task)
    }
    if (target?.cloud) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${target.workspaceId}`])
    await lockFactoryCompletionTasks(client, original.userId, original.id)
    const { rows: [issue] } = await client.query('SELECT * FROM issues WHERE id=$1 FOR UPDATE', [original.issueId])
    const { rows: [source] } = await client.query<Run>('SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [original.id, original.userId])
    if (!source || source.stopReason !== 'provider_failure' || source.status !== 'failed') { await client.query('COMMIT'); return null }
    const prior = record(source)
    if (prior?.state !== 'pending') {
      // A resource refusal racing another completed handoff cannot authorize
      // launching that child. Keep the committed receipt without rewriting it.
      const next = receipt.state !== 'stopped' && prior?.retryRunId ? await readSource(client, source.userId, prior.retryRunId) : null
      await client.query('COMMIT')
      return next?.deviceId && next.status === 'queued' && !next.stopRequestedAt && await providerContinuationLaunchMatches(client, source, next)
        ? { runId: next.id, previousRunId: source.id, deviceId: next.deviceId, cloud: next.agentDefinition?.executionIdentity?.billingAccount.runtime.kind === 'e2b', workspaceId: next.agentDefinition?.executionIdentity?.workspaceId ?? '' } : null
    }
    const stopped = async () => {
      // Retirement, cancellation and a replaced Factory request are terminal
      // for this intent. Do not leave the thread polling a handoff that can no
      // longer be authorized, and do not emit a model-setup request for it.
      await client.query(`UPDATE agent_runs SET report=report||jsonb_build_object('modelFallback',$3::jsonb),"updatedAt"=now()
        WHERE id=$1 AND "userId"=$2`, [source.id, source.userId, JSON.stringify({ ...prior, state: 'stopped' })])
      await runListChanged(client, source.id)
      await runChanged(client, source.id)
      await client.query('COMMIT')
      return null
    }
    if (source.stopRequestedAt || !issue || ['done', 'cancelled', 'canceled'].includes(issue.status) ||
      !await (await import('./run-completion')).mayCompleteIssue(issue, source.userId)) return await stopped()
    const { rows: tasks } = await client.query(`SELECT t.status,t."sourceEventId" AS "requestEpoch",a.output->>'requestEpoch' AS epoch,t."attemptId",a.id FROM factory_attempts a
      JOIN factory_tasks t ON t.id=a."taskId" WHERE a."runId"=$1 AND t."userId"=$2`, [source.id, source.userId])
    if (tasks.some(task => task.status !== 'running' || (task.epoch && task.requestEpoch !== task.epoch) || task.attemptId !== task.id)) return await stopped()
    if (target && await (await import('./factory/candidate-recheck')).candidateRecheckPinsRun(client, source.userId, source.id))
      throw new ActionFailureError('runInvalid')
    let continuation: Continuation | null = null
    await withDatabaseClient(client, async () => {
      if (target && source.agentDefinition && source.issueId) {
        const policyCeiling = await providerContinuationPolicy(client, source.userId, source.id)
        const { routing: _previousRouting, ...dispatch } = source.agentDefinition.modelDispatch!
        const modelDispatch = { ...dispatch, mode: 'preference' as const, entry: target.entry,
          ...(target.routing ? { routing: target.routing } : {}) }
        const selection = { model: target.model, modelDispatch, ...(target.subscriptionBindingId ? { subscriptionBindingId: target.subscriptionBindingId } : {}),
          ...(target.entry.source.kind === 'api_key' ? { apiKeyId: target.entry.source.keyId } : {}) }
        let runId: string
        if (target.cloud && target.botId) {
          const { queueCloudRun } = await import('./computer/queue-run')
          const { tiptapToText } = await import('./tiptap-text')
          const queued = await queueCloudRun(pool, { userId: source.userId, workspaceId: target.workspaceId }, {
            ...selection, botId: target.botId, issueId: source.issueId, agentId: target.agentId, deviceRepoId: target.deviceRepoId,
            title: issue.title, body: tiptapToText(issue.content), readOnly: source.agentDefinition.readOnly,
            withoutBot: source.botId === null, idempotencyKey: `provider:${source.id}`,
            frozenSourceRunId: source.id,
            allowLocalRecovery: source.agentDefinition.allowLocalRecovery,
            sourceEventId: source.agentDefinition.repositoryAdmission?.requestEventId,
          }, client)
          runId = queued.runId
        } else {
          const queued = await (await import('./agent-runs')).queueProviderFallbackRun(client, source.userId, source, { ...selection, agentId: target.agentId, deviceRepoId: target.deviceRepoId })
          runId = queued.runId
        }
        const queued = await readSource(client, source.userId, runId)
        if (!queued?.agentDefinition) throw new ActionFailureError('runInvalid')
        const { assertRunProjectExecution } = await import('./project-resources/run-lease')
        if (queued.agentDefinition.projectExecution) assertRunProjectExecution(source, source.agentDefinition.projectExecution, queued.agentDefinition.projectExecution)
        else if (source.agentDefinition.projectExecution) throw new ActionFailureError('projectEnvironmentUnavailable')
        // Admission checks the frozen Project target. Independent Factory
        // checks execute a candidate SHA instead; restore that exact checkout
        // below before this transaction publishes the continuation.
        const resourceBaseBranch = source.agentDefinition.projectExecution ? source.agentDefinition.projectExecution.baseBranch : source.baseBranch
        if (queued.baseBranch !== resourceBaseBranch) throw new ActionFailureError('projectRepositoryDenied')
        const prompt = providerContinuationPrompt(source.prompt)
        const definition = providerContinuationDefinition(source.agentDefinition, queued.agentDefinition, prompt, policyCeiling)
        const identity = await freezeExecutionIdentity(client, { ...queued, agentDefinition: definition }, undefined, source.agentDefinition.executionIdentity?.workspaceId)
        const previous = executionIdentitySchema.parse(source.agentDefinition.executionIdentity)
        if (!isDeepStrictEqual(standingIdentity(previous), standingIdentity(identity))) throw new ActionFailureError('executionAccountUnavailable')
        definition.executionIdentity = identity
        await client.query(`UPDATE agent_runs SET "retryOf"=$2,attempt=$3,kind=$4,"baseBranch"=$5,prompt=$6,"agentDefinition"=$7,"source"=$8,"updatedAt"=now() WHERE id=$1`,
          [runId, source.id, source.attempt, source.kind, source.baseBranch, prompt, JSON.stringify(definition), source.source])
        receipt = { ...receipt, state: 'switched', to: choice(target.entry), retryRunId: runId, nextDefinitionDigest: definition.definitionDigest }
        continuation = { runId, previousRunId: source.id, deviceId: target.deviceId, cloud: target.cloud, workspaceId: target.workspaceId }
      }
      await client.query(`UPDATE agent_runs SET report=COALESCE(report,'{}'::jsonb)||jsonb_build_object('modelFallback',$3::jsonb),"updatedAt"=now() WHERE id=$1 AND "userId"=$2`, [source.id, source.userId, JSON.stringify(receipt)])
      await runListChanged(client, source.id)
      await runChanged(client, source.id)
      if (receipt.state === 'switched' && receipt.retryRunId)
        await (await import('./factory/store')).adoptProviderContinuation(client, source.userId, source.id, receipt.retryRunId)
      const event = receipt.state === 'switched' ? {
        userId: source.userId, botId: source.botId, issueId: source.issueId, runId: source.id, kind: 'run_report' as const,
        dedupeKey: `model_fallback:${source.id}`, payload: { source: 'model_fallback', fallback: receipt.fallback,
          from: receipt.from, to: receipt.to, retryRunId: receipt.retryRunId,
          text: `${receipt.from.model}：${reasonLine(receipt.fallback === 'balance' ? 'balance' : 'providerUnavailable')} → ${receipt.to!.model}` },
      } : { ...runFinishedEvent({ ...source, stopReason: 'provider_failure', report: runReport.parse(source.report) }), payload: {
        status: 'failed', stopReason: 'provider_failure', runKind: source.kind, noModel: receipt.card,
        modelFallback: { state: receipt.state, fallback: receipt.fallback, from: receipt.from, reasons: receipt.reasons },
      } }
      await recordCoordinatorEvent(drizzle(client), event)
    })
    await client.query('COMMIT')
    return continuation
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  })
}

/** The existing dispatcher retains all owner, workspace, location and device
 * constraints. Attempted entries cannot re-enter the same recovery chain. */
export async function recoverProviderFailure(pool: Pool, userId: string, runId: string): Promise<Continuation | null> {
  const source = await readSource(pool, userId, runId)
  if (!source || source.stopReason !== 'provider_failure' || source.status !== 'failed') return null
  const initial = record(source)
  if (!initial) return null
  if (source.stopRequestedAt) return initial.state === 'pending' ? settle(pool, source, initial) : null
  if (initial.state !== 'pending' && initial.state !== 'switched') return null
  const workspaceId = source.workspaceId
  if (!workspaceId) throw new ActionFailureError('executionAccountUnavailable')
  try {
    const { withProjectResourceLease } = await import('./project-resources/store')
    return await withProjectResourceLease(userId, workspaceId, async () => {
      if (initial.state === 'switched') {
        const next = initial.retryRunId ? await readSource(pool, userId, initial.retryRunId) : null
        if (!next?.deviceId || next.workspaceId !== workspaceId || next.stopRequestedAt || next.status !== 'queued' ||
          !await providerContinuationLaunchMatches(pool, source, next)) return null
        await assertRunProjectResources(pool, next)
        return { runId: next.id, previousRunId: source.id, deviceId: next.deviceId,
          cloud: next.agentDefinition?.executionIdentity?.billingAccount.runtime.kind === 'e2b', workspaceId }
      }
      // Refuse an obsolete source before choosing credentials or preparing a
      // runtime. The same lease pins resources through the handoff's commit.
      await assertRunProjectResources(pool, source)
      return recoverAuthorizedProviderFailure(pool, source, initial)
    })
  } catch (error) {
    if (!isProjectExecutionRefusal(error)) throw error
    if (initial.state === 'switched') return null // The already committed handoff remains historical fact.
    // Completion and worker-token revocation have already committed. Reuse
    // the terminal intent receipt so replay cannot keep preparing runtimes.
    return settle(pool, source, { ...initial, state: 'stopped', reasons: [{ choice: initial.from, reason: error.code }] })
  }
}

async function recoverAuthorizedProviderFailure(pool: Pool, source: Run, initial: ModelFallbackRecord): Promise<Continuation | null> {
  const userId = source.userId
  // The order dispatch tried (优先使用的 Agent's list first, decision 2026-11-05-0400), so what came before this run is what was tried.
  const scope = await fallbackScope(pool, source), stored = await readOrder(pool, scope)
  const { autoModelRouting } = stored
  const attempted = await attemptedEntries(pool, source, dispatchOrder(stored.entries, stored.preferredHarness), autoModelRouting)
  // The Owner requested these checks on their original subscription/model.
  // Keep the historical preference snapshot intact; the host receipt pins
  // this round before any alternate model selection or runtime preparation.
  if (await (await import('./factory/candidate-recheck')).candidateRecheckPinsRun(pool, userId, source.id))
    return settle(pool, source, await unavailableRecord(pool, scope, source, attempted, [], true))
  if (source.agentDefinition?.modelDispatch?.mode !== 'preference' || source.questionContinuation || source.agentDefinition?.agentProfile?.definition.model.mode === 'fixed')
    return settle(pool, source, await unavailableRecord(pool, scope, source, attempted))
  const { rows: [origin] } = await pool.query<{ kind: string; repoPath: string | null; remoteUrl: string | null }>(`SELECT d.kind,repo."repoPath",repo."remoteUrl" FROM devices d
    LEFT JOIN device_repos repo ON repo.id=$3 AND repo."userId"=$2 WHERE d.id=$1 AND d."ownerId"=$2`, [source.deviceId, source.userId, source.deviceRepoId])
  if (!origin) return settle(pool, source, await unavailableRecord(pool, scope, source, attempted))
  const location = origin.kind === 'cloud' && !source.agentDefinition.allowLocalRecovery ? 'cloud' : source.agentDefinition.modelDispatch.location
  // A monitor's candidate environment is fixed. Its next model must run on
  // that same machine; the Factory admission rechecks the exact repository.
  const monitor = (await pool.query(`SELECT 1 FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId"
    WHERE t."userId"=$1 AND a."runId"=$2 AND t.stage='monitor'`, [userId, source.id])).rowCount !== 0
  const checkpointUnavailable = source.report?.providerCheckpoint === 'unavailable'
  const skipped: SkippedEntry[] = []
  for (let index = 0; index <= stored.entries.length; index++) {
    const selected: ModelDispatch = await resolveModelDispatch(pool, scope, null, location, source.agentDefinition.pinnedDeviceId ?? ((monitor || checkpointUnavailable) && origin.kind === 'local' ? source.deviceId ?? undefined : undefined),
      { excludeEntryKeys: [...attempted].map(key => decodeURIComponent(key)), cloudPurpose: origin.remoteUrl ? 'task' : 'desktop',
        ...(autoModelRouting && source.agentDefinition.modelDispatch.routing ? { routing: { issueId: source.issueId ?? undefined,
          previous: source.agentDefinition.modelDispatch.routing, escalate: true, effort: source.agentDefinition.agentProfile?.effort } } : {}),
        ...(source.agentDefinition.agentProfile?.definition.harness && source.agentDefinition.agentProfile.definition.harness !== 'auto' ? { harness: source.agentDefinition.agentProfile.definition.harness } : {}) })
    if (selected.kind === 'none') return settle(pool, source, await unavailableRecord(pool, scope, source, attempted, [...skipped, ...selected.skipped ?? []]))
    attempted.add(attemptKey(selected.entry))
    try {
      // A compatible source does not authorize another runtime or harness.
      // Check each target before creating a repo, Bot or cloud preparation;
      // the outer resource lease keeps this decision valid through admission.
      await withRunProjectExecution({ userId, workspaceId: source.workspaceId!, issueId: source.issueId!,
        repositoryKey: origin.remoteUrl ? origin.repoPath : null, baseBranch: source.baseBranch,
        runtime: selected.kind === 'device' ? 'local' : 'cloud', harness: selected.entry.harness }, source.agentDefinition.projectExecution, async () => undefined)
    } catch (error) {
      if (!isProjectExecutionRefusal(error)) throw error
      skipped.push({ entry: selected.entry, block: { usable: false, reason: 'noDevice' } })
      continue
    }
    let target: Parameters<typeof settle>[3]
    try { if (selected.kind === 'device' && origin.remoteUrl) {
      const repo = await (await import('./device-repositories')).ensureDeviceRepository(userId, selected.deviceId, origin.remoteUrl)
      target = { ...selected, deviceRepoId: repo.id, cloud: false, botId: scope.botId, workspaceId: scope.workspaceId }
    } else if (selected.kind === 'cloud' && !checkpointUnavailable) {
      const botId = scope.botId ?? await (await import('./computer/auto-runtime')).ensureCoordinatorBot(pool, { userId, workspaceId: scope.workspaceId })
      const { rows: [runtime] } = await pool.query<{ agentId: string; deviceId: string; repoId: string }>(`SELECT rt."agentId",a."deviceId",rt."repoId" FROM bot_cloud_runtimes rt
        JOIN agents a ON a.id=rt."agentId" AND a."userId"=rt."ownerId"
        WHERE rt."botId"=$1 AND rt."ownerId"=$2 AND rt."workspaceId"=$3 AND rt.harness=$4`, [botId, userId, scope.workspaceId, selected.harness])
      if (runtime) {
        const binding = selected.entry.source.kind === 'subscription' ? await bindAgentToConnection(pool, scope, runtime.agentId, selected.harness, selected.entry.source.connectionId, selected.model) : undefined
        const ready = await (await import('./computer/dispatch-runtime')).prepareBotCloudTaskRuntime(pool, { userId, workspaceId: scope.workspaceId }, {
          botId, agentId: runtime.agentId, harness: selected.harness, model: selected.model, withoutBot: source.botId === null,
          ...(origin.remoteUrl ? { repo: origin.remoteUrl } : {}), ...(binding ? { subscriptionBindingId: binding } : {}),
          ...(selected.entry.source.kind === 'api_key' ? { apiKeyId: selected.entry.source.keyId } : {}) })
        if (ready && ready.agentId === runtime.agentId) {
          // Waking a Bot may replace its cloud device and repository while
          // retaining the Agent id. Use its newly authorized placement.
          const { rows: [current] } = await pool.query<{ deviceId: string; repoId: string }>(`SELECT a."deviceId",rt."repoId" FROM bot_cloud_runtimes rt
            JOIN agents a ON a.id=rt."agentId" AND a."userId"=rt."ownerId"
            JOIN devices d ON d.id=a."deviceId" AND d."ownerId"=rt."ownerId" AND d.kind='cloud' AND d.enabled=true
            JOIN device_repos repo ON repo.id=rt."repoId" AND repo."userId"=rt."ownerId" AND repo."deviceId"=d.id
            WHERE rt."botId"=$1 AND rt."ownerId"=$2 AND rt."workspaceId"=$3 AND rt.harness=$4 AND rt."agentId"=$5`,
          [botId, userId, scope.workspaceId, selected.harness, ready.agentId])
          if (!current) { skipped.push({ entry: selected.entry, block: { usable: false, reason: 'noDevice' } }); continue }
          const repoId = origin.remoteUrl ? (await (await import('./device-repositories')).ensureDeviceRepository(userId, current.deviceId, origin.remoteUrl)).id : current.repoId
          target = { agentId: ready.agentId, deviceId: current.deviceId, deviceRepoId: repoId, model: selected.model, entry: selected.entry,
            ...(selected.routing ? { routing: selected.routing } : {}),
            ...(binding ? { subscriptionBindingId: binding } : {}), cloud: true, botId, workspaceId: scope.workspaceId }
        }
      }
    }
    if (target && (!monitor || (target.deviceId === source.deviceId && target.deviceRepoId === source.deviceRepoId)))
      return await settle(pool, source, { ...initial, attempted: [...attempted] }, target)
    } catch (error) {
      // Selection and admission are separate authorized reads. A credential
      // or device can be removed between them; that candidate is unavailable,
      // not a reason to leave a permanent pending intent. Unexpected faults
      // still propagate for the durable watchdog to replay.
      if (error instanceof ActionFailureError && ['executionAccountUnavailable', 'executionModelUnknown', 'agentNoDevice', 'agentHarnessMissing'].includes(error.code)) {
        skipped.push({ entry: selected.entry, block: { usable: false, reason: error.code.startsWith('execution') ? 'missing' : 'noDevice' } })
        continue
      }
      if (error instanceof ComputerError && [403, 404, 409].includes(error.status)) {
        skipped.push({ entry: selected.entry, block: { usable: false, reason: 'noDevice' } })
        continue
      }
      throw error
    }
    skipped.push({ entry: selected.entry, block: { usable: false, reason: 'noDevice' } })
  }
  return settle(pool, source, await unavailableRecord(pool, scope, source, attempted, skipped))
}

/** Commit the handoff before acknowledging the completed worker. Parking the
 * previous VM revokes its device token, so only the durable host workflow may
 * do the next run's database work and retry a retained-machine wake. */
export async function launchProviderContinuation(userId: string, continuation: Continuation | null) {
  if (!continuation) return
  const { pool } = await import('./db')
  const source = await readSource(pool, userId, continuation.previousRunId)
  const next = await readSource(pool, userId, continuation.runId)
  if (!source || !next || next.workspaceId !== continuation.workspaceId || next.status !== 'queued' || next.stopRequestedAt ||
    next.deviceId !== continuation.deviceId || !await providerContinuationLaunchMatches(pool, source, next)) return
  try {
    await withRunProjectResources(pool, next, async () => {
      if (continuation.cloud) {
        const [{ start }, { factoryCloudStageHandoff }] = await Promise.all([import('workflow/api'), import('@/workflows/factory-stage/workflow')])
        await start(factoryCloudStageHandoff, [{ userId, workspaceId: continuation.workspaceId }, continuation.previousRunId, continuation.runId, true])
      }
      else (await import('./device-gateway-notify')).notifyDeviceWork(continuation.deviceId)
    })
  } catch (error) {
    if (!isProjectExecutionRefusal(error)) throw error
  }
}
