import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { userSecrets, workspaceSecrets } from '@/lib/db/secrets-schema'
import { runChanged } from '@/lib/live/panels'
import { runListChanged } from '@/lib/live/lists'
import { notifyStoppedPolicyRuns, type StoppedPolicyRun } from '@/lib/run-policy-stop'
import type { SecretsTx } from './store'

export type SecretChange = { name: string } & (
  | { ownerId: string }
  | { workspaceId: string; scopeType: 'workspace' | 'repository' | 'project' | 'thread'; scopeRef: string }
)

type Candidate = { id: string; userId: string; deviceId: string; workspaceId: string | null; remoteUrl: string | null;
  personalResources: boolean; scopes: string[] }
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
    SELECT r.id,r."userId",r."deviceId",${workspace} AS "workspaceId",mikka_run_personal_resources_allowed(r.id) AS "personalResources",
      ARRAY(WITH RECURSIVE ancestry AS (
        SELECT p.*,0 AS depth FROM resource_access_policies p WHERE p.kind='thread' AND p.id=r.id
        UNION ALL SELECT p.*,a.depth+1 FROM ancestry a JOIN resource_access_policies p
          ON p.kind=a."parentKind" AND p.id=a."parentId" WHERE a.depth<32
      ) SELECT kind||':'||id::text FROM ancestry) AS scopes,
      CASE WHEN r."agentDefinition" ? 'repositoryAdmission' THEN r."agentDefinition"->'repositoryAdmission'->>'remoteUrl'
        ELSE repo."remoteUrl" END AS "remoteUrl"
    FROM agent_runs r JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
    LEFT JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId" AND repo."deviceId"=r."deviceId"
    WHERE r."stopRequestedAt" IS NULL AND r.status IN ('preparing','running','paused','waiting_input','finishing')
      AND (r."userId"=ANY(${sql.param(ownerIds)}::text[]) OR ${workspace}=ANY(${sql.param(workspaceIds)}::text[]))`)
  if (!candidates.length) return 0

  const names = [...new Set(changes.filter(change => 'workspaceId' in change).map(change => change.name))]
  const owners = [...new Set(candidates.map(run => run.userId))]
  const personalRows = names.length ? await tx.select({ userId: userSecrets.userId, name: userSecrets.name }).from(userSecrets)
    .where(and(inArray(userSecrets.userId, owners), inArray(userSecrets.name, names))) : []
  const repositoryRows = names.length && workspaceIds.length ? await tx.select({ workspaceId: workspaceSecrets.workspaceId, scopeRef: workspaceSecrets.scopeRef, name: workspaceSecrets.name }).from(workspaceSecrets)
    .where(and(inArray(workspaceSecrets.workspaceId, workspaceIds), eq(workspaceSecrets.scopeType, 'repository'), inArray(workspaceSecrets.name, names))) : []
  const personal = new Set(personalRows.map(row => key(row.userId, row.name)))
  const repositories = new Set(repositoryRows.map(row => key(row.workspaceId, row.scopeRef, row.name)))
  const { remoteRepositoryRef } = await import('./runtime')
  const ids = candidates.filter(run => {
    const repository = remoteRepositoryRef(run.remoteUrl)
    return changes.some(change => {
      if ('ownerId' in change) return change.ownerId === run.userId && run.personalResources
      if (run.workspaceId !== change.workspaceId) return false
      if (change.scopeType === 'project' || change.scopeType === 'thread') return run.scopes.includes(`${change.scopeType}:${change.scopeRef}`)
      if (run.personalResources && personal.has(key(run.userId, change.name))) return false
      return change.scopeType === 'repository' ? repository === change.scopeRef
        : !repository || !repositories.has(key(change.workspaceId, repository, change.name))
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
