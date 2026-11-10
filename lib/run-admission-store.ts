import { workerDefinitionDigest } from './agent-kit/worker-digest'
import 'server-only'
import { admitProfileSelection } from './factory/profile-admission'
import { runListChanged } from './live/lists'
import { runChanged } from './live/panels'
import { freezeExecutionIdentity, revalidateExecutionIdentity, ExecutionIdentityError } from './execution-identity'
import type { PoolClient } from 'pg'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { db, pool, withDatabaseClient } from './db'
import { agents, agentRuns, bots, coordinatorEvents, deviceRepos, devices, issues, runPublications } from './db/schema'
import { ActionFailureError } from './action-error'
import { issueForUser } from './issue-access'
import { localExecutionHarnesses } from './device-agents'
import { daemonTestMode, repositoryBindingMatches } from '@mikka/protocol/repository'
import { taskDestinationSchema } from './task-destination'
import { readIssueMetadata } from './issue-metadata'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { taskIdentifiers, taskPrefixInput } from './task-identifier-server'
import { publicationBranch } from './run-publication-policy'
import { admitRepositoryTask, matchesRepositoryAdmission } from './repository-admission'
import { lockCliAgentPolicy, lockCliTaskScope } from './agent-tool-approval/policy-store'
import type { WorkerDefinitionSnapshot } from './agent-kit/worker'
import { dispatchFingerprint, type DispatchCredential, type DispatchInput } from './run-dispatch'
import { UNFINISHED_RUN_STATUSES } from './agent-run-statuses'
import { notifyDeviceWork } from './device-gateway-notify'
import type { RunInvalidReason } from './run-invalid-reason'
import { captureTraceContext } from './tracing/context'
import { copyRunPrompt } from './run-prompt-copy'

/** Existing rows and JSON only: admission, run and publication commit together. */
export async function acceptLocalRun(input: {
  id: string; userId: string; issueId: string; agentId: string; deviceId: string; deviceRepoId: string
  source?: 'mcp' | null; botId: string | null; prompt: string; /** Code-point task range; initial briefs start at zero. */ promptTaskStart?: number | null; promptTaskLength?: number | null; definition: WorkerDefinitionSnapshot; requestEventId?: string
  dispatch?: DispatchInput & DispatchCredential; continuation?: boolean; sourceRunId?: string; profileSourceRunId?: string
  factoryContext?: { sourceEventId: string; attemptId: string }
}, existing?: PoolClient): Promise<{ runId: string; status?: typeof agentRuns.$inferSelect.status; replayed?: boolean }> {
  const client = existing ?? await pool.connect()
  try {
    if (!existing) await client.query('BEGIN')
    const result = await withDatabaseClient(client, async () => {
    const tx = db
    // The reason travels with the code so the caller acts on it instead of guessing (RUN_INVALID_REASONS).
    const invalid = (reason: RunInvalidReason) => new ActionFailureError('runInvalid', { reason })
    const readOnly = input.definition.readOnly === true
    // The setters acquire these locks before reading runs or updating workers.
    // Internal hosts prelock the same policy before taking their domain locks.
    const taskScope = await lockCliTaskScope(client, input.userId, input.issueId)
    await lockCliAgentPolicy(client, input.userId, input.agentId, input.botId, taskScope)
    const dispatchHash = input.dispatch?.requestKey ? dispatchFingerprint(input.dispatch) : null
    if (input.dispatch?.requestKey)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['dispatch-key', input.userId, input.dispatch.requestKey])}, 0))`)
    // Context comes from the host turn, never an input-schema field.
    const [event] = input.requestEventId
      ? await tx.select().from(coordinatorEvents).where(eq(coordinatorEvents.id, input.requestEventId)).for('update')
      : await tx.select().from(coordinatorEvents).where(and(eq(coordinatorEvents.issueId, input.issueId), eq(coordinatorEvents.kind, 'user_message'), sql`${coordinatorEvents.payload} ? 'taskDestination'`)).orderBy(desc(coordinatorEvents.createdAt)).limit(1).for('update')
    if (input.requestEventId || event) {
      const destination = taskDestinationSchema.safeParse(event?.payload.taskDestination)
      if (!input.requestEventId || !event || event.userId !== input.userId || event.botId !== input.botId || (event.issueId !== input.issueId && !(input.continuation && event.issueId === null)) || event.kind !== 'user_message' || !event.deliveredAt || !destination.success || destination.data.kind !== 'device' || destination.data.deviceId !== input.deviceId) throw invalid('taskDestinationMismatch')
      if (event.issueId === null) {
        const { rows: [binding] } = await client.query(`SELECT t.id FROM factory_tasks t JOIN issues i ON i.id=t."issueId"
          WHERE t."userId"=$1 AND t."issueId"=$2 AND t."sourceEventId"=$3 AND t."botId" IS NOT DISTINCT FROM $4::uuid
            AND i."ownershipState"='bound' AND t."workspaceId"=i."workspaceId"`, [input.userId, input.issueId, event.id, input.botId])
        if (!binding) throw invalid('taskDestinationMismatch')
      }
    }
    const [task] = await tx.select({ id: issues.id, userId: issues.userId, scope: issues.scope, workspaceId: issues.workspaceId, ownershipState: issues.ownershipState, scopeVersion: issues.scopeVersion, title: issues.title, content: issueAttrsContent, prefixInput: taskPrefixInput(sql`issues."userId"`) }).from(issues).where(eq(issues.id, input.issueId)).for('share')
    if (!task || task.ownershipState !== 'bound' || !task.workspaceId || !await issueForUser(input.userId, task.id)) throw invalid('issueUnavailable')
    if (JSON.stringify(await lockCliTaskScope(client,input.userId,task.id)) !== JSON.stringify(taskScope)) throw invalid('issueUnavailable')
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.userId, input.userId))).for('share')
    const [device] = await tx.select().from(devices).where(and(eq(devices.id, input.deviceId), eq(devices.ownerId, input.userId), eq(devices.kind, 'local'))).for('share')
    if (!agent || agent.deviceId !== input.deviceId || agent.harness !== input.definition.harness || !device?.enabled || !localExecutionHarnesses(device.harnesses).includes(agent.harness)) throw invalid('deviceUnavailable')
    const [repo] = await tx.select().from(deviceRepos).where(and(eq(deviceRepos.id, input.deviceRepoId), eq(deviceRepos.userId, input.userId), eq(deviceRepos.deviceId, input.deviceId))).for('share')
    if (!repo?.remoteUrl || !repositoryBindingMatches(repo.repoPath, repo.remoteUrl, { allowFile: daemonTestMode(process.env) })) throw invalid('repositoryMismatch')
    const [bot] = input.botId ? await tx.select().from(bots).where(and(eq(bots.id, input.botId), eq(bots.ownerId, input.userId))).for('share') : []
    if (input.botId && (!bot || bot.workspaceId !== task.workspaceId)) throw invalid('botUnavailable')
    // Server-selected references, never the Bot owner's personal credentials.
    const authority = { userId: input.userId, botId: input.botId, deviceId: input.deviceId, agentDefinition: input.definition }
    const executionIdentity = await (input.definition.executionIdentity
      ? revalidateExecutionIdentity(client, authority)
      : freezeExecutionIdentity(client, authority, undefined, task.workspaceId)).catch(error => { if (error instanceof ExecutionIdentityError) throw new ActionFailureError('executionAccountUnavailable'); throw error })
    if (!executionIdentity || executionIdentity.workspaceId !== task.workspaceId) throw new ActionFailureError('executionAccountUnavailable')
    const questionSource = input.definition.agentProfile && input.sourceRunId
      ? await (await import('./factory/questions/execution-continuation')).questionExecutionQueueSource(client,
        { userId: input.userId, issueId: task.id, botId: input.botId, sourceRunId: input.sourceRunId }) : null
    const profileOriginRunId = await admitProfileSelection(client, { ownerId: input.userId, workspaceId: executionIdentity.workspaceId ?? '', issueId: task.id, harness: input.definition.harness, model: input.definition.model, apiKeyId: input.definition.apiKey?.keyId, subscriptionBindingId: input.definition.subscription?.bindingId, selection: input.definition.agentProfile, sourceRunId: questionSource ?? input.profileSourceRunId, factoryContext: input.factoryContext })
    // A question's host receipt grants the same native execution. Its origin,
    // child and wake receipt must keep the exact original definition digest.
    const traceContext = captureTraceContext({ runId: input.id, threadId: input.sourceRunId ?? input.id, taskId: task.id, posthogDistinctId: input.userId })
    const definition = { ...input.definition, ...(traceContext ? { traceContext } : {}), executionIdentity, ...(profileOriginRunId && !questionSource ? { profileOriginRunId } : {}) }
    if (profileOriginRunId && !questionSource) definition.definitionDigest = workerDefinitionDigest(definition)
    const context = { workspaceId: task.workspaceId!, ...(input.requestEventId ? { requestEventId: input.requestEventId } : {}) }
    const replayMatches = async (prior: typeof agentRuns.$inferSelect) => {
      await revalidateExecutionIdentity(client, prior)
      const accepted = prior.agentDefinition?.repositoryAdmission
      const sameRun = prior.userId === input.userId && prior.botId === input.botId && prior.issueId === task.id && prior.deviceId === input.deviceId && prior.agentId === input.agentId && prior.deviceRepoId === repo.id
      // A read-only run has no task branch to compare: it matches only another read-only run.
      if (readOnly || prior.agentDefinition?.readOnly) return readOnly && prior.agentDefinition?.readOnly === true && !accepted && sameRun
      const [publication] = await tx.select().from(runPublications).where(eq(runPublications.runId, prior.id)).limit(1)
      return prior.userId === input.userId && prior.botId === input.botId && prior.issueId === task.id && prior.deviceId === input.deviceId && prior.agentId === input.agentId && prior.deviceRepoId === repo.id &&
        publication?.userId === input.userId && publication.issueId === task.id && prior.workspaceId === task.workspaceId && publication.remoteKey === repo.repoPath &&
        Boolean(accepted && publication.branch === accepted.targetBranch && matchesRepositoryAdmission(accepted, { ...context, userId: input.userId, issueId: task.id, deviceId: input.deviceId, agentId: input.agentId, remoteKey: repo.repoPath, remoteUrl: repo.remoteUrl!, targetBranch: accepted.targetBranch }))
    }
    if (input.sourceRunId) {
      const [origin] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, input.sourceRunId), eq(agentRuns.userId, input.userId))).limit(1).for('share')
      if (!origin || origin.stopRequestedAt || origin.status === 'cancelled' || !await replayMatches(origin)) throw invalid('sourceRunMismatch')
    }
    if (input.dispatch?.requestKey) {
      const [prior] = await tx.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.dispatchKey, input.dispatch.requestKey))).limit(1)
      if (prior) {
        if (prior.dispatchFingerprint !== dispatchHash || !await replayMatches(prior)) throw new ActionFailureError('runDispatchKeyConflict')
        return { runId: prior.id, status: prior.status, replayed: true }
      }
    }
    if (input.requestEventId && !input.continuation) {
      const [prior] = await tx.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.issueId, task.id), sql`${agentRuns.agentDefinition}->'repositoryAdmission'->>'requestEventId' = ${input.requestEventId}`)).limit(1)
      if (prior) {
        if (!await replayMatches(prior)) throw invalid('sourceRunMismatch')
        return { runId: prior.id }
      }
    }
    // A strict replay only reads the same accepted execution; it never
    // refreshes its receipt. Pushing needs no grant in Mikka (decision
    // 2026-11-02-1600): every run works with its owner's own GitHub
    // credential. A read-only run gets no task branch; it is still the
    // owner's run with the owner's credential.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['dispatch-issue', input.userId, task.id])}, 0))`)
    const [active] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.issueId, task.id), inArray(agentRuns.status, [...UNFINISHED_RUN_STATUSES]))).limit(1)
    if (active) throw new ActionFailureError('runAlreadyActive', { runId: active.id })
    if (readOnly) {
      await tx.insert(agentRuns).values({ id: input.id, userId: input.userId, botId: input.botId, issueId: task.id, agentId: input.agentId, deviceId: input.deviceId, deviceRepoId: repo.id, status: 'queued', kind: 'implement', source: input.source ?? null, baseBranch: repo.baseBranch, ...copyRunPrompt({ ...input, promptTaskStart: input.promptTaskStart ?? 0 }), agentDefinition: definition, dispatchKey: input.dispatch?.requestKey ?? null, dispatchFingerprint: dispatchHash })
      await runListChanged(tx, input.id)
      await runChanged(tx, input.id)
      return input.dispatch?.requestKey ? { runId: input.id, status: 'queued' as const, replayed: false } : { runId: input.id }
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-publication:' + task.id}, 0))`)
    const [previous] = await tx.select().from(runPublications).where(and(eq(runPublications.issueId, task.id), eq(runPublications.remoteKey, repo.repoPath), sql`${runPublications.branch} is not null`)).orderBy(asc(runPublications.createdAt)).limit(1)
    const identifier = previous?.identifier ?? (await taskIdentifiers([{ id: task.id, ownerId: task.userId, scope: task.scope, number: readIssueMetadata(task.content).number, prefixInput: task.prefixInput }], tx)).get(task.id) ?? null
    if (definition.traceContext && identifier) definition.traceContext.taskNumber = identifier
    const branch = previous?.branch ?? publicationBranch(identifier)
    if (!branch) throw invalid('taskIdentifierRequired')
    const admission = admitRepositoryTask({ ...context, userId: input.userId, issueId: task.id, deviceId: input.deviceId, agentId: input.agentId, remoteKey: repo.repoPath, remoteUrl: repo.remoteUrl, targetBranch: branch, now: new Date() })
    if (!admission) throw invalid('repositoryMismatch')
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'repository-branch:' + repo.repoPath + ':' + branch}, 0))`)
    const [collision] = await tx.select({ runId: runPublications.runId }).from(runPublications).where(and(eq(runPublications.remoteKey, repo.repoPath), eq(runPublications.branch, branch), ne(runPublications.issueId, task.id))).limit(1)
    if (collision) throw invalid('branchInUse')
    await tx.insert(agentRuns).values({ id: input.id, userId: input.userId, botId: input.botId, issueId: task.id, agentId: input.agentId, deviceId: input.deviceId, deviceRepoId: repo.id, status: 'queued', kind: 'implement', source: input.source ?? null, baseBranch: repo.baseBranch, ...copyRunPrompt({ ...input, promptTaskStart: input.promptTaskStart ?? 0 }), agentDefinition: { ...definition, repositoryAdmission: admission }, dispatchKey: input.dispatch?.requestKey ?? null, dispatchFingerprint: dispatchHash })
    await tx.insert(runPublications).values({ runId: input.id, userId: input.userId, issueId: task.id, scopeVersion: task.scopeVersion, issueTitle: task.title, remoteUrl: repo.remoteUrl, remoteKey: repo.repoPath, identifier, branch, baseBranch: repo.baseBranch, pushApproved: true })
    await runListChanged(tx, input.id)
    await runChanged(tx, input.id)
    return input.dispatch?.requestKey ? { runId: input.id, status: 'queued' as const, replayed: false } : { runId: input.id }
    })
    if (!existing) await client.query('COMMIT')
    // A Factory/Skill caller with an existing client owns the commit and wake.
    if (!existing && result && !('replayed' in result && result.replayed)) notifyDeviceWork(input.deviceId)
    return result
  } catch (error) { if (!existing) await client.query('ROLLBACK'); throw error }
  finally { if (!existing) client.release() }
}

/** A resumed task retains its original, server-bound device selection. */
export async function acceptedEventStillMatches(admission: import('./repository-admission').RepositoryAdmission, botId: string | null, executor: Pick<typeof db, 'select'> = db) {
  if (!admission.requestEventId) return true
  const [event] = await executor.select().from(coordinatorEvents).where(and(eq(coordinatorEvents.id, admission.requestEventId), eq(coordinatorEvents.userId, admission.userId), sql`(${coordinatorEvents.issueId} = ${admission.issueId} or (${coordinatorEvents.issueId} is null and exists (select 1 from factory_tasks t join issues i on i.id=t."issueId" where t."userId" = ${admission.userId} and t."issueId" = ${admission.issueId} and t."sourceEventId" = ${admission.requestEventId} and t."botId" is not distinct from ${botId}::uuid and (i."ownershipState"='bound' and t."workspaceId"=i."workspaceId"))))`, eq(coordinatorEvents.kind, 'user_message'), botId ? eq(coordinatorEvents.botId, botId) : isNull(coordinatorEvents.botId))).limit(1)
  const destination = taskDestinationSchema.safeParse(event?.payload.taskDestination)
  return Boolean(event?.deliveredAt && destination.success && destination.data.kind === 'device' && destination.data.deviceId === admission.deviceId)
}


/** The host re-admitted a retry on another local Agent. Both immutable
 * publication receipts must keep the original owner, scope, remote and branch.
 * An Agent-id change alone, or a copied A receipt, is never a takeover grant. */
export async function admittedRepositoryRetryMatches(client: PoolClient, prior: typeof agentRuns.$inferSelect, retry: typeof agentRuns.$inferSelect): Promise<boolean> {
  const original = prior.agentDefinition?.repositoryAdmission
  const accepted = retry.agentDefinition?.repositoryAdmission
  if (!original || !accepted || accepted.authority !== 'owner_credential' ||
    prior.userId !== retry.userId || prior.botId !== retry.botId || prior.issueId !== retry.issueId ||
    retry.retryOf !== prior.id || !prior.issueId || !prior.deviceId || !retry.deviceId ||
    accepted.workspaceId !== original.workspaceId || accepted.workspaceLinked !== original.workspaceLinked ||
    accepted.requestEventId !== original.requestEventId) return false
  const { rows } = await client.query(`SELECT p.*,repo."repoPath",repo."remoteUrl" AS "repositoryUrl",repo."deviceId" AS "repositoryDeviceId",repo."userId" AS "repositoryOwnerId"
    FROM run_publications p JOIN agent_runs r ON r.id=p."runId" JOIN device_repos repo ON repo.id=r."deviceRepoId"
    WHERE p."runId"=ANY($1::uuid[])`, [[prior.id, retry.id]])
  const before = rows.find(p => p.runId === prior.id), after = rows.find(p => p.runId === retry.id)
  if (!before || !after || prior.workspaceId !== retry.workspaceId || !prior.workspaceId || before.branch !== after.branch || before.remoteKey !== after.remoteKey) return false
  for (const [run, admission, publication] of [[prior, original, before], [retry, accepted, after]] as const) {
    if (publication.userId !== run.userId || publication.issueId !== run.issueId || publication.repositoryOwnerId !== run.userId ||
      publication.repositoryDeviceId !== run.deviceId || publication.remoteKey !== publication.repoPath ||
      !matchesRepositoryAdmission(admission, { userId: run.userId, issueId: run.issueId!, deviceId: run.deviceId!, agentId: run.agentId,
        remoteKey: publication.remoteKey, remoteUrl: publication.repositoryUrl, targetBranch: publication.branch,
        workspaceId: original.workspaceId, workspaceLinked: original.workspaceLinked, requestEventId: original.requestEventId })) return false
  }
  return true
}
