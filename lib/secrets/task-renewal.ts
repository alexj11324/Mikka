import 'server-only'
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { CodedError } from '@mikka/protocol/coded-error'
import { taskSecretAccessSchema, type TaskSecretAccess } from '@mikka/protocol/task-secrets'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { agentRuns, deviceRepos, devices, deviceTokens, issues } from '@/lib/db/schema'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { mayCompleteIssue, withRunWorkspace } from '@/lib/run-completion'
import type { DeviceCaller } from '@/lib/device-link'
import { revalidateExecutionIdentity, executionMembersActive, ExecutionIdentityError } from '@/lib/execution-identity'
import { LEASED_RUN_STATUSES } from '@/lib/run-retry'
import { issueEgressCapability, openEgressCapability, type EgressCapabilityBinding } from './egress-capability'
import { remoteRepositoryRef, taskSecretMetadata } from './runtime'
import { lockResourceAccess } from '@/lib/resource-access/store'
import { ActionFailureError } from '@/lib/action-error'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const currentToken = alias(deviceTokens, 'task_secret_current_token')

/** Control plane only: piggybacks the existing heartbeat, with one locked run
 * snapshot and current metadata checks. The API data plane never imports this.
 * A copied bearer still expires within 90 seconds after renewal is refused. */
export async function renewTaskSecretAccess(input: {
  caller: DeviceCaller
  deviceId: string
  runs: Array<{ runId: string; secretCapabilities?: string[] }>
  leases: Record<string, string>
  endpoint(runId: string): string
}, now = new Date(), env: Record<string, string | undefined> = process.env,
  clock: () => number = Date.now): Promise<{ taskSecrets: Record<string, TaskSecretAccess>; revoked: string[] }> {
  const taskSecrets: Record<string, TaskSecretAccess> = {}
  const revoked: string[] = []
  for (const reported of input.runs) {
    if (!reported.secretCapabilities?.length) continue
    if (!UUID.test(reported.runId) || !input.leases[reported.runId] || !UUID.test(input.caller.tokenId)
      || input.caller.scopeDeviceId && input.caller.scopeDeviceId !== input.deviceId) { revoked.push(reported.runId); continue }
    try {
      // Read only the persisted tenant and Task before taking the Workspace
      // lease. The locked APP snapshot must still match; tokens cannot reassign it.
      const [stored] = await db.select({ workspaceId: agentRuns.workspaceId, issueId: agentRuns.issueId }).from(agentRuns)
        .where(and(eq(agentRuns.id, reported.runId), eq(agentRuns.userId, input.caller.userId), eq(agentRuns.deviceId, input.deviceId))).limit(1)
      if (!stored?.workspaceId || !stored.issueId) { revoked.push(reported.runId); continue }
      const renewed = await withRunWorkspace(input.caller.userId, stored.workspaceId, async () => {
        const client = await pool.connect()
        try {
          return await withDatabaseClient(client, () => db.transaction(async tx => {
            await lockResourceAccess(tx, input.caller.userId, { kind: 'thread', id: reported.runId, workspaceId: stored.workspaceId! }, 'canSteer')
            // Match claim/completion's Task -> Run order. A soft delete must
            // finish before this read, or wait until this grant is committed.
            const [issue] = await tx.select({ id: issues.id, workspaceId: issues.workspaceId,
              ownershipState: issues.ownershipState, content: issueAttrsContent }).from(issues)
              .where(eq(issues.id, stored.issueId!)).for('share')
            if (!issue) return null
            const [row] = await tx.select({ run: agentRuns,
              deviceKind: devices.kind, remoteUrl: deviceRepos.remoteUrl,
              claimOwner: deviceTokens.userId, claimDevice: deviceTokens.boundDeviceId,
              claimWorkspace: deviceTokens.boundWorkspaceId,
              currentDevice: currentToken.boundDeviceId, currentWorkspace: currentToken.boundWorkspaceId,
              currentExpiresAt: currentToken.expiresAt,
            }).from(agentRuns)
              .innerJoin(devices, and(eq(devices.id, agentRuns.deviceId), eq(devices.ownerId, input.caller.userId), eq(devices.enabled, true), isNull(devices.removedAt)))
              .innerJoin(deviceTokens, and(eq(deviceTokens.id, agentRuns.deviceTokenId), isNull(deviceTokens.revokedAt)))
              .innerJoin(currentToken, and(eq(currentToken.id, input.caller.tokenId), eq(currentToken.userId, input.caller.userId), isNull(currentToken.revokedAt), or(isNull(currentToken.expiresAt), gt(currentToken.expiresAt, now))))
              .leftJoin(deviceRepos, and(eq(deviceRepos.id, agentRuns.deviceRepoId), eq(deviceRepos.userId, input.caller.userId), eq(deviceRepos.deviceId, input.deviceId)))
              .where(and(eq(agentRuns.id, reported.runId), eq(agentRuns.userId, input.caller.userId), eq(agentRuns.deviceId, input.deviceId),
                inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), isNull(agentRuns.stopRequestedAt), gt(agentRuns.leaseExpiresAt, now)))
              .for('update', { of: agentRuns })
            if (!row || row.claimOwner !== input.caller.userId || !row.run.deviceTokenId
              || row.run.leaseExpiresAt?.toISOString() !== input.leases[reported.runId]) return null
            const workspaceId = row.run.workspaceId
            if (!workspaceId || workspaceId !== stored.workspaceId || row.run.issueId !== issue.id
              || !await mayCompleteIssue(issue, row.run.userId, workspaceId)
              || row.run.agentDefinition?.executionIdentity !== undefined && row.run.agentDefinition.executionIdentity?.workspaceId !== workspaceId) return null
            if (row.deviceKind === 'cloud') {
              // The native cloud-token rotation creates a new token ID. Keep the
              // original claim ID as lineage, and accept only a current scoped
              // credential for that exact owner/cloud machine/workspace. Revoking
              // the original claim token prevents every successor from renewing.
              if (!row.claimWorkspace || row.claimDevice !== input.deviceId
                || input.caller.scopeDeviceId !== input.deviceId || input.caller.scopeWorkspaceId !== row.claimWorkspace
                || row.currentDevice !== input.deviceId || row.currentWorkspace !== row.claimWorkspace
                || workspaceId !== row.claimWorkspace) return null
            } else if (row.run.deviceTokenId !== input.caller.tokenId || row.currentDevice || row.currentWorkspace) return null
            await revalidateExecutionIdentity(pool, row.run)
            if (workspaceId && !row.run.agentDefinition?.executionIdentity
              && !await executionMembersActive(workspaceId, [row.run.userId])) return null
            const repository = remoteRepositoryRef(row.remoteUrl)
            const binding: EgressCapabilityBinding = { ownerId: row.run.userId, workspaceId, repository,
              runId: row.run.id, deviceId: input.deviceId, deviceTokenId: row.run.deviceTokenId, attempt: row.run.attempt }
            const requestedNames = reported.secretCapabilities!.map(capability =>
              openEgressCapability(capability, binding, Math.max(now.getTime(), clock()), env).name)
            // Read only the at-most-32 granted names during a heartbeat. A large
            // vault must not be scanned/decrypted for every active run or API call.
            const metadata = await taskSecretMetadata(workspaceId, repository, row.run.userId, tx, requestedNames, { runId: row.run.id })
            // SQL's initial snapshot is not the issuance time: locks, membership
            // and metadata reads may have waited. Never revive an old capability
            // or issue from an authority/lease which expired during those awaits.
            const issuedAt = Math.max(now.getTime(), clock())
            if (!Number.isSafeInteger(issuedAt) || !row.run.leaseExpiresAt || row.run.leaseExpiresAt.getTime() <= issuedAt
              || row.currentExpiresAt && row.currentExpiresAt.getTime() <= issuedAt) return null
            const names = new Set<string>()
            const grants: TaskSecretAccess['grants'] = []
            for (const capability of reported.secretCapabilities!) {
              const claims = openEgressCapability(capability, binding, issuedAt, env)
              const current = metadata.find(secret => secret.name === claims.name)
              if (names.has(claims.name) || !claims.secretId || !claims.revision || !current
                || current.id !== claims.secretId || current.revision !== claims.revision
                || current.kind !== 'secret' || current.delivery.mode !== 'protected' || !current.delivery.http) return null
              names.add(claims.name)
              grants.push(issueEgressCapability({ ...binding, name: claims.name, secret: claims.secret,
                secretId: claims.secretId, revision: claims.revision, http: claims.http, leaseExpiresAt: row.run.leaseExpiresAt }, issuedAt, env))
            }
            return taskSecretAccessSchema.parse({ version: 1, endpoint: input.endpoint(row.run.id), grants,
              unavailable: metadata.filter(secret => secret.kind === 'secret' && secret.delivery.mode === 'protected' && !names.has(secret.name)).map(secret => secret.name) })
          }))
        } finally { client.release() }
      })
      if (renewed) taskSecrets[reported.runId] = renewed
      else revoked.push(reported.runId)
    } catch (error) {
      if (!(error instanceof ExecutionIdentityError) && !(error instanceof ActionFailureError) && !(error instanceof CodedError && error.code === 'task_secret_unavailable')) throw error
      // A refused grant stops this task; no plaintext fallback or grant repair.
      revoked.push(reported.runId)
    }
  }
  return { taskSecrets, revoked }
}
