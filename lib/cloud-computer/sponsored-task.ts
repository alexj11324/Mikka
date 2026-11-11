import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { repositoryBindingMatches } from '@mikka/protocol/repository'
import type { WorkerDefinitionSnapshot } from '@/lib/agent-kit/worker'
import type { TaskMachineGrant, TaskCheckpoint } from '@/lib/eve/cloudflare-task-connection'
import { revalidateExecutionIdentity } from '@/lib/execution-identity'
import { withRunProjectResources } from '@/lib/project-resources/run-lease'

export type SponsoredTaskPlacement = Readonly<{
  provider: 'cloudflare'
  payer: 'mikka'
  ownerId: string
  workspaceId: string
  taskId: string
  botId: string
  repositoryKey: string
  requestEventId: string
}>
export type TaskMachineActor = { userId: string; workspaceId: string }
type Query = Pick<PoolClient, 'query'>
type ResourceRun = Parameters<typeof withRunProjectResources>[1]
type BoundRun = ResourceRun & {
  id: string
  botId: string
  operationId: string
  requiredCheckpoint: TaskCheckpoint | null
  until: Date | null
  repoPath: string
  remoteUrl: string
  agentDefinition: WorkerDefinitionSnapshot
}
export const hostedSnapshot = 'cloudflare-task-v1'
const denied = () => new Error('Cloudflare task machine unavailable')

export function hostedTaskEnabled(workspaceId: string) {
  const cohort = (process.env.MIKKA_CLOUDFLARE_TASK_WORKSPACES ?? '').split(',').map((id) => id.trim())
  return Boolean(process.env.MIKKA_TASK_MACHINE_BRIDGE_TOKEN) && cohort.includes(workspaceId)
}

export async function verifySponsoredChoice(query: Query, placement: SponsoredTaskPlacement) {
  if (!hostedTaskEnabled(placement.workspaceId)) throw denied()
  const result = await query.query(
    `SELECT 1 FROM coordinator_events e JOIN issues i ON i.id=$3
    JOIN bots b ON b.id=e."botId" AND b."ownerId"=e."userId" AND b."workspaceId"=i."workspaceId"
    WHERE e.id=$1 AND e."botId"=$5 AND e."userId"=$2 AND e."issueId"=i.id AND i."workspaceId"=$4 AND i."userId"=$2
      AND e.kind='user_message' AND e."deliveredAt" IS NOT NULL AND b."archivedAt" IS NULL
      AND i."ownershipState"='bound' AND e.payload->'taskDestination'='{"kind":"cloud","provider":"cloudflare"}'::jsonb`,
    [placement.requestEventId, placement.ownerId, placement.taskId, placement.workspaceId, placement.botId],
  )
  if (result.rowCount !== 1) throw denied()
}

const bindingSql = `SELECT r.id,r."userId",r."workspaceId",r."issueId",r."botId",r."agentId",r."deviceId",
      r."deviceRepoId",r."baseBranch",r."agentDefinition",m."operationId",m.lifecycle->'sponsoredRequiredCheckpoint' AS "requiredCheckpoint",
      COALESCE((m.lifecycle->>'sponsoredUntil')::timestamptz,m."workerLeaseUntil") AS until,repo."repoPath",repo."remoteUrl"
    FROM agent_runs r
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId" AND b."workspaceId"=r."workspaceId" AND b."botId"=r."botId"
    JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=b."ownerId" AND m."workspaceId"=b."workspaceId" AND m."botId"=b."botId" AND m."issueId"=r."issueId"
    JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId" AND repo."deviceId"=r."deviceId"
    WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId"=$3 AND m."snapshotId"=$4`
const activeSql = ` AND m.state IN ('starting','running')
    AND COALESCE((m.lifecycle->>'sponsoredUntil')::timestamptz,m."workerLeaseUntil")>clock_timestamp()
    AND r.status IN ('queued','preparing','running','waiting_input') AND r."stopRequestedAt" IS NULL
    AND (r.status='queued' OR r."leaseExpiresAt">clock_timestamp())`

function frozenGrant(run: BoundRun | undefined, actor: TaskMachineActor): TaskMachineGrant {
  const p = run?.agentDefinition?.taskMachine
  if (
    !run ||
    !p ||
    p.provider !== 'cloudflare' ||
    p.payer !== 'mikka' ||
    p.ownerId !== actor.userId ||
    p.workspaceId !== actor.workspaceId ||
    p.taskId !== run.issueId ||
    p.botId !== run.botId ||
    p.repositoryKey !== run.repoPath ||
    !run.remoteUrl ||
    !repositoryBindingMatches(p.repositoryKey, run.remoteUrl) ||
    run.agentDefinition.projectExecution?.repositoryKey !== p.repositoryKey ||
    run.agentDefinition.executionIdentity?.billingAccount.runtime.kind !== 'cloudflare_sponsored'
  )
    throw denied()
  return {
    ownerId: p.ownerId,
    workspaceId: p.workspaceId,
    taskId: p.taskId,
    repositoryKey: p.repositoryKey,
    runId: run.id,
    operationId: run.operationId,
    ...(run.requiredCheckpoint ? {requiredCheckpoint:run.requiredCheckpoint} : {}),
    expiresAt: run.until?.getTime() ?? 0,
  }
}

export async function readSponsoredTaskGrant(query: Query, actor: TaskMachineActor, runId: string, lock = false) {
  if (!hostedTaskEnabled(actor.workspaceId)) throw denied()
  const result = await query.query<BoundRun>(bindingSql + activeSql + (lock ? ' FOR SHARE OF r,b,m,repo' : ''), [
    runId,
    actor.userId,
    actor.workspaceId,
    hostedSnapshot,
  ])
  const run = result.rows[0]
  return { run, grant: frozenGrant(run, actor) }
}

/** Cleanup must still work after stop, withdrawal, suspension or grant expiry.
 * This operation can only tear down a previously bound exact operation. */
export async function releaseGrant(query: Query, actor: TaskMachineActor, runId: string, operationId: string) {
  // The reservation saved this key only after checking the original account,
  // human event and repository. Revocation or repository removal must not
  // strand paid compute. expiresAt=0 prevents this cleanup tuple from opening
  // a machine or using any live filesystem or process capability.
  const result = await query.query<{ taskId: string; repositoryKey: string | null }>(
    `SELECT "issueId" AS "taskId", lifecycle->>'sponsoredRepositoryKey' AS "repositoryKey"
     FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3
       AND "snapshotId"=$4 AND "operationId"=$5`,
    [runId, actor.userId, actor.workspaceId, hostedSnapshot, operationId],
  )
  const target = result.rows[0]
  if (!target) throw denied()
  if (target.repositoryKey) {
    return {ownerId: actor.userId, workspaceId: actor.workspaceId, taskId: target.taskId,
      repositoryKey: target.repositoryKey, runId, operationId, expiresAt: 0}
  }
  // In-flight rows created by the earlier provider still use their frozen Run.
  const previous = await query.query<BoundRun>(bindingSql + ' AND m."operationId"=$5', [
    runId, actor.userId, actor.workspaceId, hostedSnapshot, operationId,
  ])
  return { ...frozenGrant(previous.rows[0], actor), expiresAt: 0 }
}

export async function withSponsoredTaskGrant<T>(
  pool: Pool,
  actor: TaskMachineActor,
  runId: string,
  work: (g: TaskMachineGrant) => Promise<T>,
) {
  const first = await readSponsoredTaskGrant(pool, actor, runId)
  return withRunProjectResources(pool, first.run, async () => {
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      const current = await readSponsoredTaskGrant(tx, actor, runId, true)
      if (current.grant.operationId !== first.grant.operationId) throw denied()
      await revalidateExecutionIdentity(tx, current.run)
      const result = await work(current.grant)
      await tx.query('COMMIT')
      return result
    } catch (error) {
      await tx.query('ROLLBACK')
      throw error
    } finally {
      tx.release()
    }
  })
}
