import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { agentRuns, deviceRepos, devices, issues, runPublications } from '@/lib/db/schema'
import { verifyRunToken, workerRun } from '@/lib/mcp/worker'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { issueTeamAccess } from '@/lib/issue-team-access'
import { readCliRunPolicy } from '@/lib/agent-tool-approval/policy-store'
import { readRepositorySettings } from '@/lib/device-repositories'
import { matchesRepositoryAdmission } from '@/lib/repository-admission'
import { acceptedEventStillMatches } from '@/lib/run-admission-store'
import { repositoryPushApproved } from '@/lib/run-publication-policy'
import { linkedGitHubAccountId } from './repository-installation'
import { githubRepository } from './run-pull-request'
import type { RunGitHubScope } from './run-token-exchange'

/** Reuses the accepted repository and live CLI policy; no caller-supplied scope. */
export async function authorizeRunGitHubToken(request: Request): Promise<RunGitHubScope | null> {
  const bearer = /^Bearer (mkw_[A-Za-z0-9_-]+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
  const auth = await verifyRunToken(request, bearer)
  if (!auth) return null
  const worker = workerRun(auth)
  const [row] = await db.select({ run: agentRuns, repo: deviceRepos, device: devices, task: issues, publication: runPublications })
    .from(agentRuns)
    .innerJoin(deviceRepos, eq(deviceRepos.id, agentRuns.deviceRepoId))
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .innerJoin(issues, eq(issues.id, agentRuns.issueId))
    .innerJoin(runPublications, eq(runPublications.runId, agentRuns.id))
    .where(and(eq(agentRuns.id, worker.id), eq(agentRuns.userId, worker.userId))).limit(1)
  if (!row) return null
  const { run, repo, device, task, publication } = row
  if (!['implement', 'fix'].includes(run.kind) || !['preparing', 'running'].includes(run.status) || run.stopRequestedAt ||
    !run.leaseExpiresAt || run.leaseExpiresAt.getTime() <= Date.now() || !device.enabled ||
    device.ownerId !== worker.userId || repo.userId !== worker.userId || repo.deviceId !== device.id ||
    publication.userId !== worker.userId || publication.issueId !== task.id || !publication.pushApproved ||
    !publication.branch || publication.remoteUrl !== repo.remoteUrl || publication.remoteKey !== repo.repoPath ||
    readIssueMetadata(task.content).deletedAt) return null
  if (task.userId !== worker.userId && (task.scope !== 'workspace' || task.scopeVersion !== publication.scopeVersion ||
    !(await issueTeamAccess(task.id, worker.userId)).allowed)) return null
  try { githubRepository(publication.remoteKey) } catch { return null }
  // Factory/benchmark constraints are frozen separately from the live Bot
  // policy. A check's run token must never turn into implementation authority.
  const { rows: [frozen] } = await pool.query<{ restricted: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM improvement_benchmark_runs WHERE "runId"=$1)
    OR EXISTS (SELECT 1 FROM factory_attempts WHERE "runId"=$1 AND stage<>'execute') AS restricted`, [run.id])
  if (!frozen || frozen.restricted) return null
  const policy = await readCliRunPolicy(pool, run.id, worker.userId)
  if (policy.policy.readOnly || policy.policy.permissions.git_push === 'deny') return null
  const admission = run.agentDefinition?.repositoryAdmission
  const accepted = admission && matchesRepositoryAdmission(admission, {
    userId: worker.userId, issueId: task.id, deviceId: device.id, agentId: run.agentId,
    remoteKey: publication.remoteKey, remoteUrl: publication.remoteUrl, targetBranch: publication.branch,
    workspaceId: admission.workspaceId, workspaceLinked: admission.workspaceLinked, requestEventId: admission.requestEventId,
  }) && await acceptedEventStillMatches(admission, run.botId)
  const settings = await readRepositorySettings(worker.userId, publication.remoteUrl)
  // Both gates: the owner's live repository approval is required even when
  // git_push is allow or an accepted admission exists.
  if (!repositoryPushApproved(settings?.push, worker.userId) || (admission && !accepted)) return null
  const githubAccountId = await linkedGitHubAccountId(worker.userId)
  if (!githubAccountId) return null
  // Policy/membership/provider-account reads above may overlap STOP or expiry.
  // Recheck locally after those awaits, before handing authority to the issuer.
  if (!await verifyRunToken(request, bearer)) return null
  const [live] = await db.select({ status: agentRuns.status, stopRequestedAt: agentRuns.stopRequestedAt, leaseExpiresAt: agentRuns.leaseExpiresAt })
    .from(agentRuns).where(and(eq(agentRuns.id, run.id), eq(agentRuns.userId, worker.userId))).limit(1)
  if (!live || !['preparing', 'running'].includes(live.status) || live.stopRequestedAt || !live.leaseExpiresAt || live.leaseExpiresAt.getTime() <= Date.now()) return null
  return { runId: run.id, userId: worker.userId, remoteKey: publication.remoteKey, branch: publication.branch, githubAccountId }
}
