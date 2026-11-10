import { workerDefinitionDigest } from '@/lib/agent-kit/worker-digest'
import { personalMailboxEnabled } from '../personal-mailbox-config'
import 'server-only'
import { admitProfileSelection } from '@/lib/factory/profile-admission'
import type { ProfileFactoryContext } from '@/lib/factory/profile-watchdog'
import { freezeExecutionIdentity, revalidateExecutionIdentity, ExecutionIdentityError } from '../execution-identity'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
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
}, existing?: PoolClient, factoryContext?: Pick<ProfileFactoryContext, 'attemptId' | 'sourceEventId'>) {
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
  const client = existing ?? await pool.connect()
  try {
    if (!existing) await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
    if (digest) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-task:${digest}`])
    const request = input.allowLocalRecovery === true && input.sourceEventId ? (await client.query(`SELECT payload->'taskDestination' AS destination FROM coordinator_events
      WHERE id=$1 AND "userId"=$2 AND kind='user_message' AND ("issueId"=$3 OR "issueId" IS NULL) FOR SHARE`, [input.sourceEventId, actor.userId, input.issueId])).rows[0] : undefined
    const allowLocalRecovery = request && request.destination == null ? true as const : undefined
    // Absent stays byte-compatible with historical fingerprints; a replay
    // cannot upgrade an old cloud-only run to a newly inferred permission.
    const selectionFingerprint = createHash('sha256').update(JSON.stringify([input.subscriptionBindingId ?? null, model, input.apiKeyId ?? null, input.apiKey ?? null, ...(allowLocalRecovery ? [{ allowLocalRecovery }] : []), ...(input.modelDispatch ? [{ modelDispatch: input.modelDispatch }] : []), ...(input.agentProfile ? [{ agentProfile: input.agentProfile }] : []), ...(input.policyCeiling ? [{ policyCeiling: input.policyCeiling }] : [])])).digest('hex')
    const target = await cloudTaskTarget(client, actor, input)
    if (!target) throw new ComputerError(409, 'Bot computer task is unavailable')
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
    const readOnly = input.readOnly === true
    const frozen = freezeWorkerDefinition({ harness:target.harness,instructions,prompt,parent:input.execution?.snapshot ?? null,executionId:input.execution?.id ?? null,subscription,apiKey,model,modelDispatch:input.modelDispatch,agentProfile:input.agentProfile,policyCeiling:input.policyCeiling,allowLocalRecovery,mailboxEnabled:personalMailboxEnabled(),mailboxScope:{botId:runBotId,workspaceId:actor.workspaceId},readOnly })
    frozen.executionIdentity = await freezeExecutionIdentity(client, { userId: actor.userId, botId: runBotId, deviceId: target.deviceId, agentDefinition: frozen }, undefined, actor.workspaceId)
    const profileOriginRunId = await admitProfileSelection(client, { ownerId: actor.userId, workspaceId: actor.workspaceId, issueId: input.issueId, harness: target.harness, model: frozen.model, apiKeyId: frozen.apiKey?.keyId, subscriptionBindingId: frozen.subscription?.bindingId, selection: input.agentProfile, sourceRunId: input.threadRunId,
      ...(factoryContext ? { factoryContext } : {}) })
    if (profileOriginRunId) { frozen.profileOriginRunId = profileOriginRunId; frozen.definitionDigest = workerDefinitionDigest(frozen) }
    // A writable github.com run gets its task branch here, like a local run's (decision 2026-11-02-1600).
    const github = readOnly ? false : (await client.query('SELECT 1 FROM device_repos WHERE id=$1 AND "userId"=$2 AND "repoPath" LIKE \'v2/github.com/%\'', [input.deviceRepoId, actor.userId])).rowCount === 1
    const push = !github ? null : await (await import('./cloud-push')).admitCloudPush(client, { userId: actor.userId, issueId: input.issueId, agentId: input.agentId, deviceId: target.deviceId, deviceRepoId: input.deviceRepoId, ...(runBotId ? { workspaceId: actor.workspaceId } : {}), now: new Date() })
    const agentDefinition = push ? { ...frozen, repositoryAdmission: push.admission } : frozen
    const traceContext = captureTraceContext({ runId, threadId: input.threadRunId ?? runId, taskId: input.issueId, posthogDistinctId: actor.userId, ...(push?.publication.identifier ? { taskNumber: push.publication.identifier } : {}) })
    if (traceContext) agentDefinition.traceContext = traceContext
    await client.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,kind,"baseBranch",prompt,"botId","agentDefinition","dispatchFingerprint","promptTaskStart","promptTaskLength","workspaceId")
      VALUES ($1,$2,$3,$4,$5,$6,'queued','implement',$7,$8,$9,$10,$11,0,$12,$13)`, [runId, actor.userId, input.issueId, input.agentId, target.deviceId, input.deviceRepoId, target.baseBranch, prompt, runBotId,JSON.stringify(agentDefinition), digest ? selectionFingerprint : null, promptTaskLength, actor.workspaceId])
    if (push) await client.query(`INSERT INTO run_publications ("runId","userId","issueId","scopeVersion","issueTitle","remoteUrl","remoteKey",identifier,branch,"baseBranch","pushApproved")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`, [runId, push.publication.userId, push.publication.issueId, push.publication.scopeVersion, push.publication.issueTitle, push.publication.remoteUrl, push.publication.remoteKey, push.publication.identifier, push.publication.branch, push.publication.baseBranch])
    await client.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)', [runId, input.botId, actor.workspaceId, actor.userId])
    await client.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","snapshotId","operationId",state) VALUES ($1,$2,$3,$4,'pending',$5,'starting') ON CONFLICT DO NOTHING`, [runId, actor.workspaceId, actor.userId, input.botId, randomUUID()])
    await runListChanged(client, runId)
    await runChanged(client, runId)
    if (!existing) await client.query('COMMIT')
    return { runId }
  } catch (error) { if (!existing) await client.query('ROLLBACK'); if (error instanceof ExecutionIdentityError) throw new ComputerError(409, 'Execution identity or resource unavailable'); throw error } finally { if (!existing) client.release() }
}
