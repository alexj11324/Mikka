import 'server-only'
import { pool } from '@/lib/db'
import { authenticateDevice } from '@/lib/device-link'
import type { RunGitHubScope } from './run-token-exchange'
import { z } from 'zod'
import { runPersonalResourcesAllowed } from '@/lib/run-private-resources'

/**
 * A Bot's cloud desktop asks with its own worker device credential, scoped to
 * that desktop. It reaches only the desktop owner's GitHub credential: the
 * owner of the machine and of the Bot desktop it serves, who is also the
 * device credential's own person. `runId` names the desktop's device here.
 */
export async function authorizeDesktopGitHubToken(request: Request, deviceId: string): Promise<RunGitHubScope | null> {
  const caller = await authenticateDevice(request)
  if (!caller?.scopeDeviceId || !caller.scopeWorkspaceId || caller.scopeDeviceId !== deviceId) return null
  const { rowCount } = await pool.query(`SELECT 1 FROM cloud_machines m
    JOIN devices d ON d.id=m."deviceId"
    JOIN bot_desktops b ON b."workspaceId"=m."workspaceId" AND b."ownerId"=m."ownerId"
    WHERE m."deviceId"=$1 AND m."workspaceId"=$2 AND m."ownerId"=$3 AND m.state='running'
      AND d."ownerId"=$3 AND d.kind='cloud' AND d."removedAt" IS NULL LIMIT 1`, [deviceId, caller.scopeWorkspaceId, caller.userId])
  return rowCount ? { runId: deviceId, userId: caller.userId } : null
}

/** Natural-expiry refresh for the task machine. The device credential and
 * live run determine the owner; no model-provided owner or repository does. */
export async function authorizeDeviceRunGitHubToken(request: Request, deviceId: string, runId: string): Promise<RunGitHubScope | null> {
  if (!z.uuid().safeParse(deviceId).success || !z.uuid().safeParse(runId).success) return null
  const caller = await authenticateDevice(request)
  if (!caller || (caller.scopeDeviceId && caller.scopeDeviceId !== deviceId)) return null
  if (!await runPersonalResourcesAllowed(pool, runId, caller.userId)) return null
  const { rows: [run] } = await pool.query<{ remoteKey: string | null }>(`SELECT repo."repoPath" AS "remoteKey" FROM agent_runs r
    JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId" AND d.enabled AND d."removedAt" IS NULL
    LEFT JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId" AND repo."deviceId"=d.id
    WHERE r.id=$1 AND r."deviceId"=$2 AND r."userId"=$3
      AND (d.kind='local' OR (d.kind='cloud' AND $4::uuid=d.id))
      AND r.status IN ('preparing','running','paused','waiting_input') AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now()`,
  [runId, deviceId, caller.userId, caller.scopeDeviceId ?? null])
  return run ? { runId, userId: caller.userId, ...(run.remoteKey?.startsWith('v2/github.com/') ? { remoteKey: run.remoteKey } : {}) } : null
}
