import 'server-only'
import { pool } from '@/lib/db'
import { authenticateDevice } from '@/lib/device-link'
import type { RunGitHubScope } from './run-token-exchange'

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
