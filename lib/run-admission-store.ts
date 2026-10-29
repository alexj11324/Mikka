import 'server-only'
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm'
import { db, withDatabaseTransaction } from './db'
import { agents, agentRuns, bots, coordinatorEvents, deviceRepos, devices, issues, repositorySettings, runPublications } from './db/schema'
import { ActionFailureError } from './action-error'
import { issueForUser } from './issue-access'
import { localExecutionHarnesses } from './device-agents'
import { daemonTestMode, repositoryBindingMatches } from '@mikka/protocol/repository'
import { taskDestinationSchema } from './task-destination'
import { readIssueMetadata } from './issue-metadata'
import { taskIdentifiers } from './task-identifier-server'
import { publicationBranch } from './run-publication-policy'
import { admitRepositoryTask, matchesRepositoryAdmission } from './repository-admission'
import type { WorkerDefinitionSnapshot } from './agent-kit/worker'

/** Existing rows and JSON only: admission, run and publication commit together. */
export async function acceptLocalRun(input: {
  id: string; userId: string; issueId: string; agentId: string; deviceId: string; deviceRepoId: string
  botId: string | null; prompt: string; definition: WorkerDefinitionSnapshot; requestEventId?: string
}): Promise<{ runId: string }> {
  return db.transaction(async tx => withDatabaseTransaction(tx, async () => {
    const invalid = () => new ActionFailureError('runInvalid')
    // Context comes from the host turn, never an input-schema field.
    const [event] = input.requestEventId
      ? await tx.select().from(coordinatorEvents).where(eq(coordinatorEvents.id, input.requestEventId)).for('update')
      : await tx.select().from(coordinatorEvents).where(and(eq(coordinatorEvents.issueId, input.issueId), eq(coordinatorEvents.kind, 'user_message'), sql`${coordinatorEvents.payload} ? 'taskDestination'`)).orderBy(desc(coordinatorEvents.createdAt)).limit(1).for('update')
    if (input.requestEventId || event) {
      const destination = taskDestinationSchema.safeParse(event?.payload.taskDestination)
      if (!input.requestEventId || !event || event.userId !== input.userId || event.botId !== input.botId || event.issueId !== input.issueId || event.kind !== 'user_message' || !event.deliveredAt || !destination.success || destination.data.kind !== 'device' || destination.data.deviceId !== input.deviceId) throw invalid()
    }
    const [task] = await tx.select().from(issues).where(eq(issues.id, input.issueId)).for('share')
    if (!task || !await issueForUser(input.userId, task.id)) throw invalid()
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.userId, input.userId))).for('share')
    const [device] = await tx.select().from(devices).where(and(eq(devices.id, input.deviceId), eq(devices.ownerId, input.userId), eq(devices.kind, 'local'))).for('share')
    if (!agent || agent.deviceId !== input.deviceId || agent.harness !== input.definition.harness || !device?.enabled || !localExecutionHarnesses(device.harnesses).includes(agent.harness)) throw invalid()
    const [repo] = await tx.select().from(deviceRepos).where(and(eq(deviceRepos.id, input.deviceRepoId), eq(deviceRepos.userId, input.userId), eq(deviceRepos.deviceId, input.deviceId))).for('share')
    if (!repo?.remoteUrl || !repositoryBindingMatches(repo.repoPath, repo.remoteUrl, { allowFile: daemonTestMode(process.env) })) throw invalid()
    const [bot] = input.botId ? await tx.select().from(bots).where(and(eq(bots.id, input.botId), eq(bots.ownerId, input.userId))).for('share') : []
    if (input.botId && !bot) throw invalid()
    const context = { ...(bot ? { workspaceId: bot.workspaceId } : {}), ...(input.requestEventId ? { requestEventId: input.requestEventId } : {}) }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['repository-approval', input.userId, repo.repoPath])}, 0))`)
    if (input.requestEventId) {
      const [prior] = await tx.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.issueId, task.id), sql`${agentRuns.agentDefinition}->'repositoryAdmission'->>'requestEventId' = ${input.requestEventId}`)).limit(1)
      const accepted = prior?.agentDefinition?.repositoryAdmission
      if (prior) {
        if (prior.deviceId !== input.deviceId || prior.agentId !== input.agentId || prior.deviceRepoId !== repo.id || !accepted || !matchesRepositoryAdmission(accepted, { ...context, userId: input.userId, issueId: task.id, deviceId: input.deviceId, agentId: input.agentId, remoteKey: repo.repoPath, remoteUrl: repo.remoteUrl, targetBranch: accepted.targetBranch })) throw invalid()
        return { runId: prior.id }
      }
    }
    const [setting] = await tx.select().from(repositorySettings).where(and(eq(repositorySettings.userId, input.userId), eq(repositorySettings.remoteKey, repo.repoPath))).limit(1)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-publication:' + task.id}, 0))`)
    const [previous] = await tx.select().from(runPublications).where(and(eq(runPublications.issueId, task.id), eq(runPublications.remoteKey, repo.repoPath), sql`${runPublications.branch} is not null`)).orderBy(asc(runPublications.createdAt)).limit(1)
    const identifiers = await taskIdentifiers([{ id: task.id, ownerId: task.userId, scope: task.scope, number: readIssueMetadata(task.content).number }], tx)
    const identifier = previous?.identifier ?? identifiers.get(task.id) ?? null
    const branch = previous?.branch ?? publicationBranch(identifier)
    if (!branch) throw invalid()
    const admission = admitRepositoryTask({ ...context, userId: input.userId, issueId: task.id, deviceId: input.deviceId, agentId: input.agentId, remoteKey: repo.repoPath, remoteUrl: repo.remoteUrl, targetBranch: branch, push: setting?.push, now: new Date() })
    if (!admission) throw invalid()
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'repository-branch:' + repo.repoPath + ':' + branch}, 0))`)
    const [collision] = await tx.select({ runId: runPublications.runId }).from(runPublications).where(and(eq(runPublications.remoteKey, repo.repoPath), eq(runPublications.branch, branch), ne(runPublications.issueId, task.id))).limit(1)
    if (collision) throw invalid()
    await tx.insert(agentRuns).values({ id: input.id, userId: input.userId, botId: input.botId, issueId: task.id, agentId: input.agentId, deviceId: input.deviceId, deviceRepoId: repo.id, status: 'queued', kind: 'implement', baseBranch: repo.baseBranch, prompt: input.prompt, agentDefinition: { ...input.definition, repositoryAdmission: admission } })
    await tx.insert(runPublications).values({ runId: input.id, userId: input.userId, issueId: task.id, remoteUrl: repo.remoteUrl, remoteKey: repo.repoPath, identifier, branch, baseBranch: repo.baseBranch, pushApproved: true })
    return { runId: input.id }
  }))
}

/** A resumed task retains its original, server-bound device selection. */
export async function acceptedEventStillMatches(admission: import('./repository-admission').RepositoryAdmission, botId: string | null, executor: Pick<typeof db, 'select'> = db) {
  if (!admission.requestEventId) return true
  const [event] = await executor.select().from(coordinatorEvents).where(and(eq(coordinatorEvents.id, admission.requestEventId), eq(coordinatorEvents.userId, admission.userId), eq(coordinatorEvents.issueId, admission.issueId), eq(coordinatorEvents.kind, 'user_message'), botId ? eq(coordinatorEvents.botId, botId) : isNull(coordinatorEvents.botId))).limit(1)
  const destination = taskDestinationSchema.safeParse(event?.payload.taskDestination)
  return Boolean(destination.success && destination.data.kind === 'device' && destination.data.deviceId === admission.deviceId)
}
