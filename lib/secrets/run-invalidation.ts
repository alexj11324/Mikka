import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { userSecrets, workspaceSecrets } from '@/lib/db/secrets-schema'
import { runChanged } from '@/lib/live/panels'
import { runListChanged } from '@/lib/live/lists'
import { notifyStoppedPolicyRuns, type StoppedPolicyRun } from '@/lib/run-policy-stop'
import type { SecretsTx } from './store'

export type SecretChange = { name: string } & (
  | { ownerId: string }
  | { id: string; workspaceId: string; scopeType: 'workspace' | 'repository'; scopeRef: string }
)

type Candidate = {
  id: string; userId: string; deviceId: string; workspaceId: string | null; remoteUrl: string | null
  hasEnvironment: boolean; environmentSecretIds: unknown
}
const key = (...parts: (string | null)[]) => JSON.stringify(parts)

/**
 * Called inside the secret write transaction. Stop already-admitted consumers and expire
 * their lease; the existing control push and recovery timer handle acknowledgement/offline
 * devices. Claim and heartbeat compare the frozen secret revision to cover concurrent claims.
 * No plaintext is read and no provider request adds a database/auth round-trip.
 */
export async function stopRunsForSecretChanges(tx: SecretsTx, changes: readonly SecretChange[]): Promise<number> {
  if (!changes.length) return 0
  const ownerIds = [...new Set(changes.flatMap(change => 'ownerId' in change ? [change.ownerId] : []))]
  const workspaceIds = [...new Set(changes.flatMap(change => 'workspaceId' in change ? [change.workspaceId] : []))]
  // Use the same persisted tenant as claim and renewal. Neither an old frozen
  // null nor a device-token change can move a task's Secret consumption.
  const workspace = sql`r."workspaceId"::text`
  const { rows: candidates } = await tx.execute<Candidate>(sql`
    SELECT r.id,r."userId",r."deviceId",${workspace} AS "workspaceId",
      CASE WHEN r."agentDefinition" ? 'repositoryAdmission' THEN r."agentDefinition"->'repositoryAdmission'->>'remoteUrl'
        ELSE repo."remoteUrl" END AS "remoteUrl",
      COALESCE(jsonb_typeof(r."agentDefinition"->'projectExecution'->'environment')='object',false) AS "hasEnvironment",
      r."agentDefinition"->'projectExecution'->'environment'->'secretIds' AS "environmentSecretIds"
    FROM agent_runs r JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
    LEFT JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId" AND repo."deviceId"=r."deviceId"
    WHERE r."stopRequestedAt" IS NULL AND r.status IN ('preparing','running','paused','waiting_input','finishing')
      AND (r."userId"=ANY(${sql.param(ownerIds)}::text[]) OR ${workspace}=ANY(${sql.param(workspaceIds)}::text[]))`)
  if (!candidates.length) return 0

  const names = [...new Set(changes.filter(change => 'workspaceId' in change).map(change => change.name))]
  const owners = [...new Set(candidates.map(run => run.userId))]
  const personalRows = names.length ? await tx.select({ userId: userSecrets.userId, name: userSecrets.name }).from(userSecrets)
    .where(and(inArray(userSecrets.userId, owners), inArray(userSecrets.name, names))) : []
  const repositoryRows = names.length && workspaceIds.length ? await tx.select({ id: workspaceSecrets.id, workspaceId: workspaceSecrets.workspaceId, scopeRef: workspaceSecrets.scopeRef, name: workspaceSecrets.name }).from(workspaceSecrets)
    .where(and(inArray(workspaceSecrets.workspaceId, workspaceIds), eq(workspaceSecrets.scopeType, 'repository'), inArray(workspaceSecrets.name, names))) : []
  const personal = new Set(personalRows.map(row => key(row.userId, row.name)))
  const repositories = new Map(repositoryRows.map(row => [key(row.workspaceId, row.scopeRef, row.name), row.id]))
  const { remoteRepositoryRef } = await import('./runtime')
  const ids = candidates.filter(run => {
    const repository = remoteRepositoryRef(run.remoteUrl)
    // No Environment preserves the ordinary workspace/repository inheritance.
    // An Environment, including an empty selection, admits only its frozen IDs.
    const selected = run.hasEnvironment
      ? new Set(Array.isArray(run.environmentSecretIds) ? run.environmentSecretIds.filter((id): id is string => typeof id === 'string') : [])
      : null
    return changes.some(change => {
      if ('ownerId' in change) return change.ownerId === run.userId
      if (run.workspaceId !== change.workspaceId || personal.has(key(run.userId, change.name))) return false
      if (selected && !selected.has(change.id)) return false
      if (change.scopeType === 'repository') return repository === change.scopeRef
      const override = repository ? repositories.get(key(change.workspaceId, repository, change.name)) : undefined
      // An unselected same-name repository row cannot hide a selected workspace
      // Secret from rotation/deletion, because it never reached this Environment.
      return !override || selected !== null && !selected.has(override)
    })
  }).map(run => run.id)
  if (!ids.length) return 0
  const { rows: stopped } = await tx.execute<StoppedPolicyRun>(sql`
    UPDATE agent_runs SET "stopRequestedAt"=clock_timestamp(),
      "leaseExpiresAt"=LEAST("leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
    WHERE id=ANY(${sql.param(ids)}::uuid[]) AND "stopRequestedAt" IS NULL
      AND status IN ('preparing','running','paused','waiting_input','finishing')
    RETURNING id,"deviceId",true AS stopped`)
  for (const { id } of stopped) { await runListChanged(tx, id); await runChanged(tx, id) }
  notifyStoppedPolicyRuns(tx, stopped)
  return stopped.length
}
