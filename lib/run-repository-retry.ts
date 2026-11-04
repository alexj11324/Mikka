import 'server-only'
import { db, pool, withDatabaseClient } from './db'
import type { agentRuns } from './db/schema'
import { ActionFailureError } from './action-error'
import { ExecutionIdentityError, rebindExecutionDevice } from './execution-identity'
import { acceptLocalRun, acceptedEventStillMatches, admittedRepositoryRetryMatches } from './run-admission-store'
import { matchesRepositoryAdmission } from './repository-admission'
import { lockCliAgentPolicy, lockCliRunPolicy, lockCliTaskScope } from './agent-tool-approval/policy-store'
import { retryWorkerDefinition } from './agent-kit/worker'
import { recordCoordinatorEvent } from './coordinator-event-store'
import { runRetriedEvent } from './coordinator-events'
import { revokeRunTokens } from './mcp/worker'
import { FactoryError } from './factory/contract'
import { deviceOnlineStates } from './device-presence'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { isNoLooserThan, networkDomainsWithin } from '@mikka/protocol/agent-policy'
import { LEASED_RUN_STATUSES, MAX_RUN_ATTEMPTS, retryPrompt } from './run-retry'

type Run = typeof agentRuns.$inferSelect
export type AdmittedTakeover = { deviceId: string; deviceRepoId: string; agentId: string }

/** A local repository receipt is device-bound. Recover through ordinary
 * admission on B, after the original run/Factory epoch is locked and fenced.
 * No destination event, credential, model or grant is inferred from B. */
export async function readmitLostLocalRun(original: Run, target: AdmittedTakeover, now: Date, queued = false): Promise<{ retried: boolean; blocked?: string }> {
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN')
    const result = await withDatabaseClient(tx, async () => {
      if (!original.issueId) throw new ActionFailureError('runInvalid', { reason: 'issueUnavailable' })
      const scope = await lockCliTaskScope(tx, original.userId, original.issueId)
      for (const agentId of [...new Set([original.agentId, target.agentId])].sort())
        await lockCliAgentPolicy(tx, original.userId, agentId, original.botId, scope)
      const { factoryClaimTask } = await import('./factory/claim')
      const identity = await factoryClaimTask(tx, original.id)
      if (identity) {
        const { factoryRuntimeForBot } = await import('./factory/runtime')
        const task = await factoryRuntimeForBot(identity.botId).store.lockTask(tx, original.userId, identity.id)
        const { rows: [attempt] } = await tx.query('SELECT "runId",status,output FROM factory_attempts WHERE id=$1 AND "taskId"=$2', [task.attemptId, task.id])
        if (task.status !== 'running' || attempt?.status !== 'running' || attempt.runId !== original.id) return { retried: false }
        if (attempt.output?.requestEpoch !== task.sourceEventId)
          return { retried: false, blocked: 'The execution has no matching current request epoch. Retry from the current task request before choosing another device.' }
      }
      const { rows: [run] } = await tx.query<Run>('SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [original.id, original.userId])
      if (!run || run.stopRequestedAt || (queued ? run.status !== 'queued' : !LEASED_RUN_STATUSES.includes(run.status as typeof LEASED_RUN_STATUSES[number]) || !run.leaseExpiresAt || new Date(run.leaseExpiresAt) >= now)) return { retried: false }
      if (run.attempt >= MAX_RUN_ATTEMPTS) return { retried: false, blocked: 'No authorized recovery attempt remains. Choose an available device to retry this task.' }
      // Re-enter already-held policy locks after the Factory/run locks, so the
      // original frozen team/project hierarchy is checked without reversing
      // cancellation's task-before-run lock order. B may only narrow it.
      const originalPolicy = await lockCliRunPolicy(tx, run.id, run.userId)
      const targetPolicy = await lockCliAgentPolicy(tx, run.userId, target.agentId, run.botId, { ...scope, ...(originalPolicy.hierarchy ? { hierarchy: originalPolicy.hierarchy } : {}) })
      if (!isNoLooserThan(originalPolicy.policy, targetPolicy.policy) || !networkDomainsWithin(targetPolicy.policy.networkAllow, originalPolicy.policy.networkAllow))
        return { retried: false, blocked: 'The available device has a broader execution policy than the original worker. Keep the original restrictions before retrying this task.' }
      const { rows: devices } = await tx.query(`SELECT id,kind,enabled,"removedAt","protocolVersion","lastSeenAt" FROM devices
        WHERE id=ANY($1::uuid[]) AND "ownerId"=$2 ORDER BY id FOR SHARE`, [[target.deviceId, ...(queued && run.deviceId ? [run.deviceId] : [])], run.userId])
      const destination = devices.find(device => device.id === target.deviceId)
      if (!destination?.enabled || destination.removedAt || destination.kind !== 'local' || destination.protocolVersion < DAEMON_PROTOCOL_VERSION)
        return { retried: false, blocked: 'The selected recovery device is no longer authorized and available. Select an available device to retry this task.' }
      // Idle gateway daemons have no HTTP heartbeat. Presence has one bounded
      // lookup per device; ownership/scheduling authority remains the locked SQL.
      const presence = await deviceOnlineStates(devices, now.getTime())
      const source = queued ? devices.find(device => device.id === run.deviceId) : undefined
      if (source?.enabled && !source.removedAt && presence.get(source.id)) return { retried: false }
      if (!presence.get(target.deviceId))
        return { retried: false, blocked: 'The selected recovery device went offline before admission. Select an available device to retry this task.' }
      const admission = run.agentDefinition?.repositoryAdmission
      const { rows: [publication] } = await tx.query(`SELECT p.*,repo."repoPath",repo."remoteUrl" AS "repositoryUrl",i."scopeVersion" AS "currentScopeVersion"
        FROM run_publications p JOIN device_repos repo ON repo.id=$2 AND repo."userId"=$3 AND repo."deviceId"=$4
        JOIN issues i ON i.id=p."issueId" WHERE p."runId"=$1 FOR SHARE OF p,repo,i`, [run.id, run.deviceRepoId, run.userId, run.deviceId])
      if (!admission || !run.issueId || !run.deviceId || !publication || publication.userId !== run.userId || publication.issueId !== run.issueId ||
        publication.scopeVersion !== publication.currentScopeVersion || publication.remoteKey !== publication.repoPath ||
        !matchesRepositoryAdmission(admission, { userId: run.userId, issueId: run.issueId, agentId: run.agentId, deviceId: run.deviceId,
          remoteKey: publication.remoteKey, remoteUrl: publication.repositoryUrl, targetBranch: publication.branch,
          workspaceId: admission.workspaceId, workspaceLinked: admission.workspaceLinked, requestEventId: admission.requestEventId }) ||
        !await acceptedEventStillMatches(admission, run.botId)) throw new ActionFailureError('runInvalid', { reason: 'sourceRunMismatch' })
      if (run.agentDefinition?.pinnedDeviceId && run.agentDefinition.pinnedDeviceId !== target.deviceId)
        throw new ActionFailureError('runInvalid', { reason: 'taskDestinationMismatch' })
      const definition = await rebindExecutionDevice(tx, run, target.deviceId)
      if (!definition) throw new ActionFailureError('executionAccountUnavailable')
      const recovery = await (await import('./factory/handoff')).factoryRecoveryHandoff(pool, run, retryPrompt(run.prompt, run.attempt + 1), tx)
      if (recovery.blocked) return { retried: false, blocked: recovery.blocked }
      const retryId = crypto.randomUUID()
      // The active-task admission gate must see A as terminal. Token revocation
      // and B's fresh receipt commit atomically; a failed admission rolls back.
      await tx.query(`UPDATE agent_runs SET status='failed',"stopReason"='device_lost',error=$2,"finishedAt"=$3,"updatedAt"=$3 WHERE id=$1`,
        [run.id, `The machine went offline; handed to another device as attempt ${run.attempt + 1} of ${MAX_RUN_ATTEMPTS}.`, now])
      await revokeRunTokens(run.id)
      await acceptLocalRun({ id: retryId, userId: run.userId, issueId: run.issueId, botId: run.botId, source: run.source,
        deviceId: target.deviceId, deviceRepoId: target.deviceRepoId, agentId: target.agentId, prompt: recovery.prompt,
        definition: retryWorkerDefinition(definition, recovery.prompt)!, continuation: true,
        ...(admission.requestEventId ? { requestEventId: admission.requestEventId } : {}) }, tx)
      const { rows: [retry] } = await tx.query<Run>(`UPDATE agent_runs SET "retryOf"=$2,attempt=$3,kind=$4,"baseBranch"=$5,cli_policy_hierarchy=$6 WHERE id=$1 RETURNING *`,
        [retryId, run.id, run.attempt + 1, run.kind, run.baseBranch, originalPolicy.hierarchy ?? null])
      if (!await admittedRepositoryRetryMatches(tx, run, retry)) throw new ActionFailureError('runInvalid', { reason: 'repositoryMismatch' })
      await recordCoordinatorEvent(db, runRetriedEvent(run, { runId: retryId, attempt: retry.attempt, maxAttempts: MAX_RUN_ATTEMPTS,
        movedToDeviceId: target.deviceId, movedTo: { kind: 'device', deviceId: target.deviceId } }))
      return { retried: true }
    })
    await tx.query('COMMIT')
    return result
  } catch (error) {
    await tx.query('ROLLBACK')
    if (error instanceof Error && ['agentPolicyUnavailable', 'agentPolicyChanged'].includes(error.message))
      return { retried: false, blocked: 'The original execution policy or task hierarchy is no longer available. Review the current task scope before retrying.' }
    if (error instanceof ActionFailureError || error instanceof ExecutionIdentityError || error instanceof FactoryError)
      return { retried: false, blocked: `Recovery requires a currently authorized device, repository and unchanged execution resources (${error instanceof ActionFailureError ? error.params?.reason ?? error.code : error instanceof FactoryError ? error.code : 'executionAccountUnavailable'}). Select an available device and retry this task.` }
    throw error
  } finally { tx.release() }
}
