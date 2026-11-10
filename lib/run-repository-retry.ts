import { withRunWorkspace } from './run-completion'
import 'server-only'
import { serverRunFailure } from './run-failure-details'
import { db, pool, withDatabaseClient } from './db'
import type { agentRuns } from './db/schema'
import { ActionFailureError } from './action-error'
import { ExecutionIdentityError, rebindExecutionDevice } from './execution-identity'
import { acceptLocalRun, acceptedEventStillMatches, admittedRepositoryRetryMatches } from './run-admission-store'
import { matchesRepositoryAdmission } from './repository-admission'
import { taskDestinationSchema } from './task-destination'
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
/** The host observed this physical generation before choosing B. It is never a tool argument. */
export type CloudRecoverySource = { workspaceId: string; sandboxId: string | null; operationId: string | null; deviceId: string | null; repoId: string | null }
class CloudPauseUnconfirmed extends Error {}

/** A repository receipt is device-bound. Recover through ordinary local
 * admission on B, after the original run/Factory epoch is locked and fenced.
 * No destination event, credential, model or grant is inferred from B. */
export async function readmitLostLocalRun(original: Run, target: AdmittedTakeover, now: Date, queued = false, cloudSource?: CloudRecoverySource): Promise<{ retried: boolean; blocked?: string }> {
  const { rows: [stored] } = await pool.query<{ workspaceId: string | null }>(
    'SELECT "workspaceId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [original.id, original.userId])
  return await withRunWorkspace(original.userId, stored?.workspaceId ?? null, async () => {
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
      let requestEpoch: string | undefined
      if (identity) {
        const { factoryRuntimeForBot } = await import('./factory/runtime')
        const task = await factoryRuntimeForBot(identity.botId).store.lockTask(tx, original.userId, identity.id)
        const { rows: [attempt] } = await tx.query('SELECT "runId",status,output FROM factory_attempts WHERE id=$1 AND "taskId"=$2', [task.attemptId, task.id])
        if (task.status !== 'running' || attempt?.status !== 'running' || attempt.runId !== original.id) return { retried: false }
        if (attempt.output?.requestEpoch !== task.sourceEventId)
          return { retried: false, blocked: 'The execution has no matching current request epoch. Retry from the current task request before choosing another device.' }
        requestEpoch = task.sourceEventId
      }
      const { rows: [run] } = await tx.query<Run>('SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [original.id, original.userId])
      if (!run || run.workspaceId !== stored?.workspaceId || run.stopRequestedAt || (queued ? run.status !== 'queued' : !LEASED_RUN_STATUSES.includes(run.status as typeof LEASED_RUN_STATUSES[number]) || !run.leaseExpiresAt || new Date(run.leaseExpiresAt) >= now)) return { retried: false }
      if (run.attempt >= MAX_RUN_ATTEMPTS) return { retried: false, blocked: 'No authorized recovery attempt remains. Choose an available device to retry this task.' }
      // Re-enter already-held policy locks after the Factory/run locks, so the
      // original frozen team/project hierarchy is checked without reversing
      // cancellation's task-before-run lock order. B may only narrow it.
      const originalPolicy = await lockCliRunPolicy(tx, run.id, run.userId)
      const targetPolicy = await lockCliAgentPolicy(tx, run.userId, target.agentId, run.botId, { ...scope, ...(originalPolicy.hierarchy ? { hierarchy: originalPolicy.hierarchy } : {}) })
      if (!isNoLooserThan(originalPolicy.policy, targetPolicy.policy) || !networkDomainsWithin(targetPolicy.policy.networkAllow, originalPolicy.policy.networkAllow))
        return { retried: false, blocked: 'The available device has a broader execution policy than the original worker. Keep the original restrictions before retrying this task.' }
      const { rows: devices } = await tx.query(`SELECT id,kind,enabled,"removedAt","protocolVersion","lastSeenAt" FROM devices
        WHERE id=ANY($1::uuid[]) AND "ownerId"=$2 ORDER BY id FOR SHARE`, [[target.deviceId, ...(run.deviceId ? [run.deviceId] : [])], run.userId])
      const destination = devices.find(device => device.id === target.deviceId)
      if (!destination?.enabled || destination.removedAt || destination.kind !== 'local' || destination.protocolVersion < DAEMON_PROTOCOL_VERSION)
        return { retried: false, blocked: 'The selected recovery device is no longer authorized and available. Select an available device to retry this task.' }
      // Idle gateway daemons have no HTTP heartbeat. Presence has one bounded
      // lookup per device; ownership/scheduling authority remains the locked SQL.
      // Policy/row locks may have waited while a real heartbeat arrived. The
      // lease snapshot still fences the attempt; it is not the presence clock.
      const presence = await deviceOnlineStates(devices)
      const source = devices.find(device => device.id === run.deviceId)
      if (queued && source?.enabled && !source.removedAt && presence.get(source.id)) return { retried: false }
      if (!presence.get(target.deviceId))
        return { retried: false, blocked: 'The selected recovery device went offline before admission. Select an available device to retry this task.' }
      const { rows: [cloudBinding] } = await tx.query(`SELECT "workspaceId","botId" FROM computer_run_bindings
        WHERE "runId"=$1 AND "ownerId"=$2 FOR SHARE`, [run.id, run.userId])
      let cloudMachine: { sandboxId: string; workspaceId: string; operationId: string } | undefined
      if (source?.kind === 'cloud' || cloudBinding || run.agentDefinition?.executionIdentity?.billingAccount.runtime.kind === 'e2b') {
        if (run.agentDefinition?.allowLocalRecovery !== true)
          return { retried: false, blocked: 'The original cloud task has no automatic local recovery grant. Keep its cloud destination or choose a new destination before retrying.' }
        const { rows: [request] } = await tx.query(`SELECT payload->'taskDestination' AS destination FROM coordinator_events
          WHERE id=$1 AND "userId"=$2 AND kind='user_message' FOR SHARE`, [requestEpoch, run.userId])
        const destination = request?.destination == null ? null : taskDestinationSchema.safeParse(request.destination)
        if (!requestEpoch || !request || (destination && (!destination.success || destination.data.kind !== 'device' || destination.data.deviceId !== target.deviceId)))
          return { retried: false, blocked: 'The current request does not authorize moving this cloud task to the selected device. Choose the new destination before retrying.' }
        // A logical cloud binding alone is not proof that the old executor is
        // stopped. Lock its exact physical owner before any local admission.
        const { rows: [machine] } = await tx.query(`SELECT "sandboxId","workspaceId","operationId","botId","issueId","deviceId","repoId",state,"workerLeaseUntil"
          FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 FOR UPDATE`, [run.id, run.userId])
        if (source?.kind !== 'cloud' || !cloudBinding || !cloudSource || !machine?.sandboxId ||
          machine.workspaceId !== cloudBinding.workspaceId || machine.botId !== cloudBinding.botId ||
          machine.workspaceId !== run.agentDefinition?.executionIdentity?.workspaceId ||
          machine.issueId !== run.issueId || machine.deviceId !== run.deviceId || machine.repoId !== run.deviceRepoId ||
          !['running', 'paused'].includes(machine.state) || (machine.workerLeaseUntil && new Date(machine.workerLeaseUntil) > now))
          return { retried: false, blocked: 'The original cloud runtime cannot be safely identified or stopped. Reconnect or stop that runtime before retrying this task.' }
        // A wake/adoption completed while target selection waited. This pass
        // has no authority over the replacement generation; observe it anew.
        if (machine.operationId !== cloudSource.operationId || machine.sandboxId !== cloudSource.sandboxId ||
          machine.workspaceId !== cloudSource.workspaceId || machine.deviceId !== cloudSource.deviceId || machine.repoId !== cloudSource.repoId)
          return { retried: false }
        cloudMachine = machine
      }
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
      const recovery = await (await import('./factory/handoff')).factoryRecoveryHandoff(pool, run, retryPrompt(run, run.attempt + 1), tx)
      if (recovery.blocked) return { retried: false, blocked: recovery.blocked }
      const retryId = crypto.randomUUID()
      // The active-task admission gate must see A as terminal. Token revocation
      // and B's fresh receipt commit atomically; a failed admission rolls back.
      await tx.query(`UPDATE agent_runs SET status='failed',"stopReason"='device_lost',error=$2,"finishedAt"=$3,"updatedAt"=$3,"failureDetails"=$4::jsonb WHERE id=$1`,
        [run.id, `The machine went offline; handed to another device as attempt ${run.attempt + 1} of ${MAX_RUN_ATTEMPTS}.`, now, JSON.stringify(serverRunFailure(run.id, now))])
      await revokeRunTokens(run.id)
      await acceptLocalRun({ id: retryId, userId: run.userId, issueId: run.issueId, botId: run.botId, source: run.source,
        deviceId: target.deviceId, deviceRepoId: target.deviceRepoId, agentId: target.agentId, prompt: recovery.prompt,
        promptTaskStart: recovery.promptTaskStart, promptTaskLength: recovery.promptTaskLength,
        definition: retryWorkerDefinition(definition, recovery.prompt)!, continuation: true,
        ...(admission.requestEventId ? { requestEventId: admission.requestEventId } : {}) }, tx)
      const { rows: [retry] } = await tx.query<Run>(`UPDATE agent_runs SET "retryOf"=$2,attempt=$3,kind=$4,"baseBranch"=$5,cli_policy_hierarchy=$6 WHERE id=$1 RETURNING *`,
        [retryId, run.id, run.attempt + 1, run.kind, run.baseBranch, originalPolicy.hierarchy ?? null])
      if (!await admittedRepositoryRetryMatches(tx, run, retry)) throw new ActionFailureError('runInvalid', { reason: 'repositoryMismatch' })
      if (cloudMachine) {
        // Provider-confirmed pause and old device-token revocation happen
        // before B is visible. A refused pause rolls back B's fresh receipt;
        // an ended/missing machine was rejected above, not treated as proof.
        try {
          await (await import('./cloud-computer/thread-machines')).parkThreadMachine(pool, { userId: run.userId, workspaceId: cloudMachine.workspaceId }, run.id, undefined, undefined, tx)
          const parked = await tx.query(`SELECT 1 FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3
            AND "sandboxId"=$4 AND "deviceId"=$5 AND "operationId"=$6 AND "repoId"=$7 AND state='paused'`, [run.id, run.userId, cloudMachine.workspaceId, cloudMachine.sandboxId, run.deviceId, cloudMachine.operationId, run.deviceRepoId])
          if (!parked.rowCount) throw new CloudPauseUnconfirmed()
          await tx.query('UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "boundDeviceId"=$1 AND "userId"=$2', [run.deviceId, run.userId])
        } catch { throw new CloudPauseUnconfirmed() }
      }
      await recordCoordinatorEvent(db, runRetriedEvent(run, { runId: retryId, attempt: retry.attempt, maxAttempts: MAX_RUN_ATTEMPTS,
        movedToDeviceId: target.deviceId, movedTo: { kind: 'device', deviceId: target.deviceId } }))
      return { retried: true }
    })
    await tx.query('COMMIT')
    return result
  } catch (error) {
    await tx.query('ROLLBACK')
    if (error instanceof CloudPauseUnconfirmed)
      return { retried: false, blocked: 'The cloud provider did not confirm that the original runtime is paused. Stop or reconnect that cloud machine before retrying this task.' }
    if (error instanceof Error && ['agentPolicyUnavailable', 'agentPolicyChanged'].includes(error.message))
      return { retried: false, blocked: 'The original execution policy or task hierarchy is no longer available. Review the current task scope before retrying.' }
    if (error instanceof ActionFailureError || error instanceof ExecutionIdentityError || error instanceof FactoryError)
      return { retried: false, blocked: `Recovery requires a currently authorized device, repository and unchanged execution resources (${error instanceof ActionFailureError ? error.params?.reason ?? error.code : error instanceof FactoryError ? error.code : 'executionAccountUnavailable'}). Select an available device and retry this task.` }
    throw error
  } finally { tx.release() }
  }) ?? { retried: false, blocked: 'Recovery requires active membership in the original workspace.' }
}
