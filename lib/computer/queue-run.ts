import { workerDefinitionDigest } from '@/lib/agent-kit/worker-digest'
import { scheduleConversationTitle } from '@/lib/conversation-title-schedule'
import { personalMailboxEnabled } from '../personal-mailbox-config'
import 'server-only'
import { admitProfileSelection } from '@/lib/factory/profile-admission'
import type { ProfileFactoryContext } from '@/lib/factory/profile-watchdog'
import { freezeExecutionIdentity, revalidateExecutionIdentity, ExecutionIdentityError } from '../execution-identity'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { connectForCommitEffects } from '../db/commit-effects'
import { z } from 'zod'
import { runPromptParts } from '@/lib/run-prompt'
import { freezeWorkerDefinition, type WorkerModelDispatch } from '@/lib/agent-kit/worker'
import { captureTraceContext } from '@/lib/tracing/context'
import type { AgentExecution } from '@/lib/agent-kit/store'
import { ComputerError } from './store'
import { RunModelMissingError } from './run-model'
import { runCredentialSource, type RunApiKey } from '@/lib/run-credential-source'
import { cloudTaskTarget } from './cloud-task-target'
import { runListChanged } from '@/lib/live/lists'
import { runChanged } from '@/lib/live/panels'
import { resolveRunOrigin, type RunOrigin, type RunOriginRef } from '@/lib/run-origin'
import type { ProjectExecutionSnapshot } from '@/lib/project-resources/contracts'
import { assertFrozenProjectExecution, assertProjectExecutionTarget, requireProjectResourceLease } from '@/lib/project-resources/store'

/** Issue access is checked by the caller. Queue and Bot binding are committed
 * together so the cloud worker never observes an unbound queued run. The
 * workspace 电脑 policy governs computer use only: a computer task (its
 * repository has no remote, so it needs the desktop) is refused under deny; a
 * repository task (a remote, run on a task machine without a desktop) is not.
 * factoryContext comes only from the locked host dispatch; it preserves Profile
 * recovery admission independently of the parent computer's current state. */
export async function queueCloudRun(pool: Pool, actor: { userId: string; workspaceId: string }, input: {
  botId: string; issueId: string; agentId: string; deviceRepoId: string; title: string; body: string; note?: string
  /** Host recovery guidance belongs to execution instructions, never the person's run note. */
  executionNote?: string
  /** The run keeps no bot of its own, like the run it continues (an MCP client's): it still runs on `botId`'s computer. */
  withoutBot?: boolean
  /** Required (lib/computer/run-model.ts): a new run's from 优先使用的模型, a thread's next run its own. Never 'auto' or empty. */
  model: string
  /** Host-recorded preference or explicit choice; the resolved model alone grants no fallback. */
  modelDispatch?: WorkerModelDispatch
  agentProfile?: Parameters<typeof freezeWorkerDefinition>[0]['agentProfile']
  policyCeiling?: Parameters<typeof freezeWorkerDefinition>[0]['policyCeiling']
  /** The run this one continues, named in the error when the model is missing. */
  threadRunId?: string
  /** Host provider recovery retains resource configuration without inheriting a native session or Profile. */
  frozenSourceRunId?: string
  idempotencyKey?: string; execution?: AgentExecution
  /** A quota continuation's key (lib/run-quota.ts): frozen as given instead of choosing the credential. */
  apiKey?: RunApiKey
  /** The API key the 优先使用的模型 entry names; used only when the run may use it (lib/run-credential-source.ts). */
  apiKeyId?: string
  /** The dispatcher's exact subscription selection; an id is reauthorized here, never an owner grant. */
  subscriptionBindingId?: string
  /** An investigation that changes nothing: read-only policy and no task branch. */
  readOnly?: boolean
  /** Internal host placement grant, never a model/tool argument. The current owner source can only narrow it. */
  allowLocalRecovery?: true
  sourceEventId?: string
  /** Evidence-only entry provenance (lib/run-origin.ts). A host continuation
   * copies its source run's. Every production caller passes it explicitly;
   * lib/run-origin-writes.test.ts enumerates the call sites. */
  origin?: RunOrigin; originRef?: RunOriginRef | null
}, existing?: PoolClient, factoryContext?: Pick<ProfileFactoryContext, 'attemptId' | 'sourceEventId'>, projectExecution?: ProjectExecutionSnapshot): Promise<{ runId: string }> {
  if (input.idempotencyKey !== undefined && (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 256)) throw new ComputerError(400, 'Invalid task request')
  if (input.subscriptionBindingId !== undefined && (!z.uuid().safeParse(input.subscriptionBindingId).success || input.apiKeyId || input.apiKey)) throw new ComputerError(400, 'Invalid task request')
  const digest = input.idempotencyKey === undefined ? undefined : createHash('sha256').update(JSON.stringify([actor.userId, input.idempotencyKey])).digest('hex')
  const runId = digest ? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}` : randomUUID()
  // A run is never frozen without its model: a caller that left it out fails here, before anything is written.
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!model || model === 'auto' || (input.apiKey && input.apiKey.model !== model)) {
    const error = new RunModelMissingError(runId, input.threadRunId ?? null)
    console.error(JSON.stringify({ msg: 'cloud_run_model_missing', runId, threadRunId: input.threadRunId ?? null, issueId: input.issueId, agentId: input.agentId }))
    throw error
  }
  // Validate the entry before taking a connection: an invalid ref must not leak one.
  // The web default is for legacy tests; the write guard enumerates every
  // production caller so none can rely on it silently.
  const entry = resolveRunOrigin({ explicit: input.origin ? { origin: input.origin, originRef: input.originRef } : null, defaultOrigin: 'web' })
  if (!projectExecution) {
    const { rows: [target] } = await (existing ?? pool).query(`SELECT repo."repoPath",repo."remoteUrl",a.harness,
        CASE WHEN source.id IS NULL THEN repo."baseBranch"
          WHEN source."agentDefinition"->'projectExecution' IS NOT NULL THEN source."agentDefinition"->'projectExecution'->>'baseBranch'
          ELSE source."baseBranch" END AS "baseBranch"
      FROM device_repos repo JOIN agents a ON a.id=$2 AND a."userId"=$3
      JOIN issues i ON i.id=$4 AND i."workspaceId"=$5 AND i."ownershipState"='bound'
      LEFT JOIN agent_runs source ON source.id=$6 AND source."userId"=$3 AND source."issueId"=i.id AND source."workspaceId"=i."workspaceId"
      WHERE repo.id=$1 AND repo."userId"=$3`, [input.deviceRepoId, input.agentId, actor.userId, input.issueId, actor.workspaceId, input.frozenSourceRunId ?? input.threadRunId ?? null])
    if (!target) throw new ComputerError(409, 'Bot computer task is unavailable')
    const { withProjectExecution } = await import('@/lib/project-resources/store')
    return withProjectExecution({ userId: actor.userId, workspaceId: actor.workspaceId, issueId: input.issueId, repositoryKey: target.remoteUrl ? target.repoPath : null, baseBranch: target.baseBranch, runtime: 'cloud', harness: target.harness },
      snapshot => queueCloudRun(pool, actor, input, existing, factoryContext, snapshot), Boolean(existing))
  }
  requireProjectResourceLease(actor.userId, actor.workspaceId)
  // Standalone callers can supply their own pg pool. Observe it before the
  // checkout, so run notifications follow its actual commit or rollback.
  const client = existing ?? await connectForCommitEffects(pool)
  try {
    if (!existing) await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
    if (digest) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-task:${digest}`])
    const request = input.sourceEventId ? (await client.query(`SELECT payload->'taskDestination' AS destination FROM coordinator_events
      WHERE id=$1 AND "userId"=$2 AND kind='user_message' AND ("issueId"=$3 OR "issueId" IS NULL) FOR SHARE`, [input.sourceEventId, actor.userId, input.issueId])).rows[0] : undefined
    const sponsored = request?.destination?.kind === 'cloud' && request.destination.provider === 'cloudflare'
    const allowLocalRecovery = input.allowLocalRecovery === true && request && request.destination == null ? true as const : undefined
    // Absent stays byte-compatible with historical fingerprints; a replay
    // cannot upgrade an old cloud-only run to a newly inferred permission.
    const selectionFingerprint = createHash('sha256').update(JSON.stringify([input.subscriptionBindingId ?? null, model, input.apiKeyId ?? null, input.apiKey ?? null, ...(allowLocalRecovery ? [{ allowLocalRecovery }] : []), ...(sponsored ? [{ cloudflareRequest:input.sourceEventId }] : []), ...(input.modelDispatch ? [{ modelDispatch: input.modelDispatch }] : []), ...(input.agentProfile ? [{ agentProfile: input.agentProfile }] : []), ...(input.policyCeiling ? [{ policyCeiling: input.policyCeiling }] : [])])).digest('hex')
    const target = await cloudTaskTarget(client, actor, input)
    if (!target) throw new ComputerError(409, 'Bot computer task is unavailable')
    const { rows: [repository] } = await client.query<{ repoPath: string; remoteUrl: string | null }>('SELECT "repoPath","remoteUrl" FROM device_repos WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3 FOR SHARE', [input.deviceRepoId, actor.userId, target.deviceId])
    if (!repository) throw new ComputerError(409, 'Bot computer task is unavailable')
    assertProjectExecutionTarget(projectExecution, { userId: actor.userId, workspaceId: actor.workspaceId, repositoryKey: repository.remoteUrl ? repository.repoPath : null, runtime: 'cloud', harness: target.harness })
    const instructions = [target.instructions, input.agentProfile?.instructions, input.executionNote].filter(Boolean).join('\n\n')
    const { prompt, taskLength: promptTaskLength } = runPromptParts(input.title, input.body, instructions, input.note)
    if (digest) {
      const priorRun = (await client.query(`SELECT r."userId",r."issueId",r."agentId",r."deviceId",r."deviceRepoId",r.prompt,r."agentDefinition",r."dispatchFingerprint",r."botId" AS "runBotId",b."botId",b."workspaceId"
        FROM agent_runs r LEFT JOIN computer_run_bindings b ON b."runId"=r.id WHERE r.id=$1`, [runId])).rows[0]
      if (priorRun) {
        if (priorRun.userId !== actor.userId || priorRun.issueId !== input.issueId || priorRun.agentId !== input.agentId || priorRun.deviceId !== target.deviceId || priorRun.deviceRepoId !== input.deviceRepoId || priorRun.runBotId !== (input.withoutBot ? null : input.botId) || priorRun.botId !== input.botId || priorRun.workspaceId !== actor.workspaceId || priorRun.prompt !== prompt) throw new ComputerError(409, 'Task request changed')
        if ((!priorRun.agentDefinition || priorRun.agentDefinition.harness !== target.harness || (priorRun.agentDefinition.parent?.executionId ?? null) !== (input.execution?.id ?? null))) throw new ComputerError(409,'Task request changed')
        if (priorRun.dispatchFingerprint ? priorRun.dispatchFingerprint !== selectionFingerprint : input.subscriptionBindingId && priorRun.agentDefinition.subscription?.bindingId !== input.subscriptionBindingId) throw new ComputerError(409, 'Task request changed')
        await revalidateExecutionIdentity(client, { ...priorRun, botId: priorRun.runBotId })
        if (!existing) await client.query('COMMIT')
        return { runId }
      }
    }
    // Every cloud run freezes its definition (Agent, model, credential source) when it is created (orchestration.md § 5):
    // the Agent's subscription bound here, else the person's API key. The key is opened only when the run is claimed.
    const binding = await (await import('./native-run-binding')).nativeRunBinding(client, actor.userId, input.agentId, target.harness, actor.workspaceId, input.subscriptionBindingId)
    if (input.subscriptionBindingId && (!binding || model !== binding.modelId)) throw new ComputerError(409, 'Bot subscription unavailable')
    const runBotId = input.withoutBot ? null : input.botId
    const { subscription, apiKey } = input.apiKey ? { subscription: null, apiKey: input.apiKey } : await runCredentialSource(client, { ownerId: actor.userId, botId: runBotId, harness: target.harness, model, keyId: input.apiKeyId,
      botWorkspaceId: runBotId ? actor.workspaceId : null, choiceWorkspaceId: actor.workspaceId, subscription: binding })
    // A key selected before runtime preparation can be withdrawn during wake.
    if (input.apiKeyId && apiKey?.keyId !== input.apiKeyId) throw new ComputerError(409, 'Bot subscription unavailable')
    if (!subscription && !apiKey) throw new ComputerError(409,'Bot subscription unavailable')
    // The hosted runner starts a subscription run only on that subscription's own model: a different one is refused here, not at startup.
    if (subscription && subscription.modelId !== model) throw new ComputerError(409, 'Bot subscription unavailable')
    const frozen = freezeWorkerDefinition({ harness:target.harness,instructions,prompt,parent:input.execution?.snapshot ?? null,executionId:input.execution?.id ?? null,subscription,apiKey,model,modelDispatch:input.modelDispatch,agentProfile:input.agentProfile,policyCeiling:input.policyCeiling,allowLocalRecovery,mailboxEnabled:personalMailboxEnabled(),mailboxScope:{botId:runBotId,workspaceId:actor.workspaceId},readOnly:input.readOnly })
    const sourceId = input.frozenSourceRunId ?? input.threadRunId
    const prior = sourceId ? (await client.query('select "agentDefinition","baseBranch" from agent_runs where id=$1 and "userId"=$2 and "workspaceId"=$3 and "issueId"=$4 FOR SHARE', [sourceId, actor.userId, actor.workspaceId, input.issueId])).rows[0] : undefined
    if (sourceId && !prior) throw new ComputerError(409, 'Original task execution is unavailable')
    if (prior) {
      const { assertRunProjectExecution } = await import('@/lib/project-resources/run-lease')
      assertRunProjectExecution(prior, prior.agentDefinition?.projectExecution, projectExecution)
    }
    const effectiveExecution: ProjectExecutionSnapshot | undefined = prior ? prior.agentDefinition?.projectExecution : projectExecution
    if (effectiveExecution) {
      assertFrozenProjectExecution(effectiveExecution, projectExecution)
      frozen.projectExecution = structuredClone(effectiveExecution)
    }
    const effectiveBaseBranch = effectiveExecution ? effectiveExecution.baseBranch : prior ? prior.baseBranch : projectExecution.baseBranch
    const earlierPlacement = prior?.agentDefinition?.taskMachine
    if (earlierPlacement || sponsored) {
      if (input.withoutBot || !repository.remoteUrl || !effectiveExecution?.repositoryKey || !subscription || !['codex','claude_code'].includes(target.harness) ||
          (prior && !earlierPlacement) || (earlierPlacement && (earlierPlacement.ownerId!==actor.userId || earlierPlacement.workspaceId!==actor.workspaceId ||
             earlierPlacement.taskId!==input.issueId || earlierPlacement.botId!==input.botId || earlierPlacement.repositoryKey!==effectiveExecution.repositoryKey)))
        throw new ComputerError(409,'Cloudflare coding task unavailable')
      frozen.taskMachine=earlierPlacement ?? {provider:'cloudflare',payer:'mikka',ownerId:actor.userId,workspaceId:actor.workspaceId,
        taskId:input.issueId,botId:input.botId,repositoryKey:effectiveExecution.repositoryKey,requestEventId:input.sourceEventId!}
    }
    frozen.definitionDigest = workerDefinitionDigest(frozen)
    frozen.executionIdentity = await freezeExecutionIdentity(client, { userId: actor.userId, botId: runBotId, deviceId: target.deviceId, agentDefinition: frozen }, undefined, actor.workspaceId)
    const profileOriginRunId = await admitProfileSelection(client, { ownerId: actor.userId, workspaceId: actor.workspaceId, issueId: input.issueId, harness: target.harness, model: frozen.model, apiKeyId: frozen.apiKey?.keyId, subscriptionBindingId: frozen.subscription?.bindingId, selection: input.agentProfile, sourceRunId: input.threadRunId,
      ...(factoryContext ? { factoryContext } : {}) })
    if (profileOriginRunId) { frozen.profileOriginRunId = profileOriginRunId; frozen.definitionDigest = workerDefinitionDigest(frozen) }
    // A writable github.com run gets its task branch here, like a local run's (decision 2026-11-02-1600).
    const github = input.readOnly ? false : (await client.query('SELECT 1 FROM device_repos WHERE id=$1 AND "userId"=$2 AND "repoPath" LIKE \'v2/github.com/%\'', [input.deviceRepoId, actor.userId])).rowCount === 1
    const push = !github ? null : await (await import('./cloud-push')).admitCloudPush(client, { userId: actor.userId, issueId: input.issueId, agentId: input.agentId, deviceId: target.deviceId, deviceRepoId: input.deviceRepoId, baseBranch: effectiveBaseBranch, workspaceId: actor.workspaceId, now: new Date() })
    const agentDefinition = push ? { ...frozen, repositoryAdmission: push.admission } : frozen
    const traceContext = captureTraceContext({ runId, threadId: input.threadRunId ?? runId, taskId: input.issueId, posthogDistinctId: actor.userId, ...(push?.publication.identifier ? { taskNumber: push.publication.identifier } : {}) })
    if (traceContext) agentDefinition.traceContext = traceContext
    // The conversation is named once this commits (decision 2026-11-13-1405); a run that continues one takes its title.
    scheduleConversationTitle(client, runId, actor.userId, 'created')
    await client.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,kind,"baseBranch",prompt,"botId","agentDefinition","dispatchFingerprint","promptTaskStart","promptTaskLength","workspaceId",origin,"originRef")
      VALUES ($1,$2,$3,$4,$5,$6,'queued','implement',$7,$8,$9,$10,$11,0,$12,$13,$14,$15)`, [runId, actor.userId, input.issueId, input.agentId, target.deviceId, input.deviceRepoId, effectiveBaseBranch, prompt, runBotId,JSON.stringify(agentDefinition), digest ? selectionFingerprint : null, promptTaskLength, actor.workspaceId, entry.origin, entry.originRef ? JSON.stringify(entry.originRef) : null])
    if (push) await client.query(`INSERT INTO run_publications ("runId","userId","issueId","scopeVersion","issueTitle","remoteUrl","remoteKey",identifier,branch,"baseBranch","pushApproved")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`, [runId, push.publication.userId, push.publication.issueId, push.publication.scopeVersion, push.publication.issueTitle, push.publication.remoteUrl, push.publication.remoteKey, push.publication.identifier, push.publication.branch, push.publication.baseBranch])
    await client.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)', [runId, input.botId, actor.workspaceId, actor.userId])
    await client.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","snapshotId","operationId",state,"issueId") VALUES ($1,$2,$3,$4,$5,$6,'starting',$7) ON CONFLICT DO NOTHING`, [runId, actor.workspaceId, actor.userId, input.botId, frozen.taskMachine ? 'cloudflare-task-v1' : 'pending', randomUUID(), frozen.taskMachine ? input.issueId : null])
    await runListChanged(client, runId)
    await runChanged(client, runId)
    if (!existing) await client.query('COMMIT')
    return { runId }
  } catch (error) { if (!existing) await client.query('ROLLBACK'); if (error instanceof ExecutionIdentityError) throw new ComputerError(409, 'Execution identity or resource unavailable'); throw error } finally { if (!existing) client.release() }
}
