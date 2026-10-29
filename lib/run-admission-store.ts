import 'server-only'
import type { PoolClient } from 'pg'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { db, pool, withDatabaseClient } from './db'
import { agents, agentRuns, bots, coordinatorEvents, deviceRepos, devices, issues, repositorySettings, runPublications } from './db/schema'
import { ActionFailureError } from './action-error'
import { issueForUser } from './issue-access'
import { localExecutionHarnesses } from './device-agents'
import { daemonTestMode, repositoryBindingMatches } from '@mikka/protocol/repository'
import { taskDestinationSchema } from './task-destination'
import { readIssueMetadata } from './issue-metadata'
import { taskIdentifiers } from './task-identifier-server'
import { publicationBranch } from './run-publication-policy'
import { admitRepositoryTask, effectiveRepositoryPush, matchesRepositoryAdmission } from './repository-admission'
import { lockCliAgentPolicy } from './agent-tool-approval/policy-store'
import type { WorkerDefinitionSnapshot } from './agent-kit/worker'
import { dispatchFingerprint, type DispatchInput } from './run-dispatch'
import { UNFINISHED_RUN_STATUSES } from './agent-run-statuses'

/** Existing rows and JSON only: admission, run and publication commit together. */
export async function acceptLocalRun(input: {
  id: string; userId: string; issueId: string; agentId: string; deviceId: string; deviceRepoId: string
  source?: 'mcp' | null; botId: string | null; prompt: string; definition: WorkerDefinitionSnapshot; requestEventId?: string; approvedRepositoryKey?: string
  dispatch?: DispatchInput; continuation?: boolean; sourceRunId?: string
}, existing?: PoolClient): Promise<{ runId: string; status?: typeof agentRuns.$inferSelect.status; replayed?: boolean }> {
  const client = existing ?? await pool.connect()
  try {
    if (!existing) await client.query('BEGIN')
    const result = await withDatabaseClient(client, async () => {
    const tx = db
    const invalid = () => new ActionFailureError('runInvalid')
    // The setters acquire these locks before reading runs or updating workers.
    // Internal hosts prelock the same policy before taking their domain locks.
    const currentPolicy = await lockCliAgentPolicy(client, input.userId, input.agentId, input.botId)
    const dispatchHash = input.dispatch?.requestKey ? dispatchFingerprint(input.dispatch) : null
    if (input.dispatch?.requestKey)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['dispatch-key', input.userId, input.dispatch.requestKey])}, 0))`)
    // Context comes from the host turn, never an input-schema field.
    const [event] = input.requestEventId
      ? await tx.select().from(coordinatorEvents).where(eq(coordinatorEvents.id, input.requestEventId)).for('update')
      : await tx.select().from(coordinatorEvents).where(and(eq(coordinatorEvents.issueId, input.issueId), eq(coordinatorEvents.kind, 'user_message'), sql`${coordinatorEvents.payload} ? 'taskDestination'`)).orderBy(desc(coordinatorEvents.createdAt)).limit(1).for('update')
    if (input.requestEventId || event) {
      const destination = taskDestinationSchema.safeParse(event?.payload.taskDestination)
      if (!input.requestEventId || !event || event.userId !== input.userId || event.botId !== input.botId || (event.issueId !== input.issueId && !(input.continuation && event.issueId === null)) || event.kind !== 'user_message' || !event.deliveredAt || !destination.success || destination.data.kind !== 'device' || destination.data.deviceId !== input.deviceId) throw invalid()
      if (event.issueId === null) {
        const { rows: [binding] } = await client.query(`SELECT t.id FROM factory_tasks t JOIN issues i ON i.id=t."issueId"
          WHERE t."userId"=$1 AND t."issueId"=$2 AND t."sourceEventId"=$3 AND t."botId" IS NOT DISTINCT FROM $4::uuid
            AND (i."userId"=t."userId" OR (i.scope='workspace' AND t."scopeVersion" IS NOT NULL AND t."scopeVersion"=i."scopeVersion"))`, [input.userId, input.issueId, event.id, input.botId])
        if (!binding) throw invalid()
      }
    }
    const [task] = await tx.select().from(issues).where(eq(issues.id, input.issueId)).for('share')
    if (!task || !await issueForUser(input.userId, task.id)) throw invalid()
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.userId, input.userId))).for('share')
    const [device] = await tx.select().from(devices).where(and(eq(devices.id, input.deviceId), eq(devices.ownerId, input.userId), eq(devices.kind, 'local'))).for('share')
    if (!agent || agent.deviceId !== input.deviceId || agent.harness !== input.definition.harness || !device?.enabled || !localExecutionHarnesses(device.harnesses).includes(agent.harness)) throw invalid()
    const [repo] = await tx.select().from(deviceRepos).where(and(eq(deviceRepos.id, input.deviceRepoId), eq(deviceRepos.userId, input.userId), eq(deviceRepos.deviceId, input.deviceId))).for('share')
    if (!repo?.remoteUrl || !repositoryBindingMatches(repo.repoPath, repo.remoteUrl, { allowFile: daemonTestMode(process.env) })) throw invalid()
    if (input.approvedRepositoryKey && (!input.requestEventId || repo.repoPath !== input.approvedRepositoryKey)) throw invalid()
    const [bot] = input.botId ? await tx.select().from(bots).where(and(eq(bots.id, input.botId), eq(bots.ownerId, input.userId))).for('share') : []
    if (input.botId && !bot) throw invalid()
    const context = { ...(bot ? { workspaceId: bot.workspaceId } : {}), ...(input.requestEventId ? { requestEventId: input.requestEventId } : {}) }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['repository-approval', input.userId, repo.repoPath])}, 0))`)
    const [setting] = await tx.select().from(repositorySettings).where(and(eq(repositorySettings.userId, input.userId), eq(repositorySettings.remoteKey, repo.repoPath))).limit(1).for('share')
    const replayMatches = async (prior: typeof agentRuns.$inferSelect) => {
      const accepted = prior.agentDefinition?.repositoryAdmission
      const [publication] = await tx.select().from(runPublications).where(eq(runPublications.runId, prior.id)).limit(1)
      return prior.userId === input.userId && prior.botId === input.botId && prior.issueId === task.id && prior.deviceId === input.deviceId && prior.agentId === input.agentId && prior.deviceRepoId === repo.id &&
        publication?.userId === input.userId && publication.issueId === task.id && publication.scopeVersion === task.scopeVersion && publication.remoteKey === repo.repoPath &&
        Boolean(accepted && publication.branch === accepted.targetBranch && matchesRepositoryAdmission(accepted, { ...context, userId: input.userId, issueId: task.id, deviceId: input.deviceId, agentId: input.agentId, remoteKey: repo.repoPath, remoteUrl: repo.remoteUrl!, targetBranch: accepted.targetBranch }))
    }
    if (input.sourceRunId) {
      const [origin] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, input.sourceRunId), eq(agentRuns.userId, input.userId))).limit(1).for('share')
      if (!origin || origin.stopRequestedAt || origin.status === 'cancelled' || !await replayMatches(origin)) throw invalid()
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
        if (!await replayMatches(prior)) throw invalid()
        return { runId: prior.id }
      }
    }
    // A strict replay only reads the same accepted execution. It never
    // refreshes its receipt; current policy gates every newly queued run.
    if (effectiveRepositoryPush(currentPolicy.policy.permissions, setting?.push, input.userId) !== 'allow') throw invalid()
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['dispatch-issue', input.userId, task.id])}, 0))`)
    const [active] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.issueId, task.id), inArray(agentRuns.status, [...UNFINISHED_RUN_STATUSES]))).limit(1)
    if (active) throw new ActionFailureError('runAlreadyActive', { runId: active.id })
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-publication:' + task.id}, 0))`)
    const [previous] = await tx.select().from(runPublications).where(and(eq(runPublications.issueId, task.id), eq(runPublications.remoteKey, repo.repoPath), sql`${runPublications.branch} is not null`)).orderBy(asc(runPublications.createdAt)).limit(1)
    const identifiers = await taskIdentifiers([{ id: task.id, ownerId: task.userId, scope: task.scope, number: readIssueMetadata(task.content).number }], tx)
    const identifier = previous?.identifier ?? identifiers.get(task.id) ?? null
    const branch = previous?.branch ?? publicationBranch(identifier)
    if (!branch) throw invalid()
    const admission = admitRepositoryTask({ ...context, userId: input.userId, issueId: task.id, deviceId: input.deviceId, agentId: input.agentId, remoteKey: repo.repoPath, remoteUrl: repo.remoteUrl, targetBranch: branch, push: setting?.push, permissions: currentPolicy.policy.permissions, now: new Date() })
    if (!admission) throw invalid()
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'repository-branch:' + repo.repoPath + ':' + branch}, 0))`)
    const [collision] = await tx.select({ runId: runPublications.runId }).from(runPublications).where(and(eq(runPublications.remoteKey, repo.repoPath), eq(runPublications.branch, branch), ne(runPublications.issueId, task.id))).limit(1)
    if (collision) throw invalid()
    await tx.insert(agentRuns).values({ id: input.id, userId: input.userId, botId: input.botId, issueId: task.id, agentId: input.agentId, deviceId: input.deviceId, deviceRepoId: repo.id, status: 'queued', kind: 'implement', source: input.source ?? null, baseBranch: repo.baseBranch, prompt: input.prompt, agentDefinition: { ...input.definition, repositoryAdmission: admission }, dispatchKey: input.dispatch?.requestKey ?? null, dispatchFingerprint: dispatchHash })
    await tx.insert(runPublications).values({ runId: input.id, userId: input.userId, issueId: task.id, scopeVersion: task.scopeVersion, issueTitle: task.title, remoteUrl: repo.remoteUrl, remoteKey: repo.repoPath, identifier, branch, baseBranch: repo.baseBranch, pushApproved: true })
    return input.dispatch?.requestKey ? { runId: input.id, status: 'queued' as const, replayed: false } : { runId: input.id }
    })
    if (!existing) await client.query('COMMIT')
    return result
  } catch (error) { if (!existing) await client.query('ROLLBACK'); throw error }
  finally { if (!existing) client.release() }
}

/** A resumed task retains its original, server-bound device selection. */
export async function acceptedEventStillMatches(admission: import('./repository-admission').RepositoryAdmission, botId: string | null, executor: Pick<typeof db, 'select'> = db) {
  if (!admission.requestEventId) return true
  const [event] = await executor.select().from(coordinatorEvents).where(and(eq(coordinatorEvents.id, admission.requestEventId), eq(coordinatorEvents.userId, admission.userId), sql`(${coordinatorEvents.issueId} = ${admission.issueId} or (${coordinatorEvents.issueId} is null and exists (select 1 from factory_tasks t join issues i on i.id=t."issueId" where t."userId" = ${admission.userId} and t."issueId" = ${admission.issueId} and t."sourceEventId" = ${admission.requestEventId} and t."botId" is not distinct from ${botId}::uuid and (i."userId"=t."userId" or (i.scope='workspace' and t."scopeVersion" is not null and t."scopeVersion"=i."scopeVersion")))))`, eq(coordinatorEvents.kind, 'user_message'), botId ? eq(coordinatorEvents.botId, botId) : isNull(coordinatorEvents.botId))).limit(1)
  const destination = taskDestinationSchema.safeParse(event?.payload.taskDestination)
  return Boolean(event?.deliveredAt && destination.success && destination.data.kind === 'device' && destination.data.deviceId === admission.deviceId)
}
