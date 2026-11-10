import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { agentRuns, deviceRepos, devices } from '@/lib/db/schema'
import { verifyRunToken, workerRun } from '@/lib/mcp/worker'
import type { RunGitHubScope } from './run-token-exchange'
import { runPersonalResourcesAllowed } from '@/lib/run-private-resources'

const LIVE = ['preparing', 'running']

/**
 * A live run of this person, on their own enabled device, holding its lease:
 * its run token may fetch the person's own GitHub credential (decision
 * 2026-11-02-1600). Any run kind, read-only or not; the request names no
 * repository, branch or person, so it can only ever reach the run owner's.
 */
export async function authorizeRunGitHubToken(request: Request): Promise<RunGitHubScope | null> {
  const bearer = /^Bearer (mkw_[A-Za-z0-9_-]+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
  const auth = await verifyRunToken(request, bearer)
  if (!auth) return null
  const worker = workerRun(auth)
  const [row] = await db.select({ run: agentRuns, device: devices, repoPath: deviceRepos.repoPath, repoUserId: deviceRepos.userId })
    .from(agentRuns)
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .leftJoin(deviceRepos, eq(deviceRepos.id, agentRuns.deviceRepoId))
    .where(and(eq(agentRuns.id, worker.id), eq(agentRuns.userId, worker.userId))).limit(1)
  if (!row) return null
  const { run, device } = row
  if (run.userId !== worker.userId || !LIVE.includes(run.status) || run.stopRequestedAt || !run.leaseExpiresAt || run.leaseExpiresAt.getTime() <= Date.now() ||
    !device.enabled || device.ownerId !== worker.userId) return null
  if (!await runPersonalResourcesAllowed(pool, run.id, worker.userId)) return null
  const remoteKey = row.repoUserId === worker.userId && row.repoPath?.startsWith('v2/github.com/') ? row.repoPath : undefined
  return { runId: run.id, userId: worker.userId, ...(remoteKey ? { remoteKey } : {}) }
}
