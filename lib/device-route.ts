import { CLIENT_VERSION_HEADER } from '@mikka/protocol/version'
import { daemonRequestTooOld, daemonUpgradeResponse, daemonUpdateControlRequest, daemonRunRequestId } from './daemon-release'
import { authenticateDevice } from './device-link'
import { deviceRequestCaller } from './device-request-context'
import { withDeviceDatabaseAuthority, withDeviceUnitFence, isDeviceAuthorityRevoked, isDeviceAuthorityError } from './db/device-scope'
import { pool } from './db'
import { deploymentSwitch } from './deployment-switches'

/** Reuse each statement/transaction's write connection for the credential
 * lock. Long polls recheck whenever they query; no lock spans a wait or body.
 * Every handler's first database statement takes that lock before it acts, so
 * there is no separate check up front (it cost five statements per request).
 * So a handler must not call out, issue a credential (GitHub token, policy
 * snapshot, subscription lease) or write anything before its first database
 * statement; lib/device-route-fence.db.test.ts runs every route with a revoked
 * token to hold that. */
export function withDeviceRoute<Args extends unknown[]>(handler: (request: Request, ...args: Args) => Promise<Response>) {
  return async (request: Request, ...args: Args): Promise<Response> => {
    const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
    const caller = await authenticateDevice(request)
    if (!caller) return unauthorized()
    // Authentication remains first: updating alone must not revive a revoked
    // credential. Conversely, a fresh login must not admit an old binary.
    if (daemonRequestTooOld(request.headers.get(CLIENT_VERSION_HEADER), Boolean(caller.scopeDeviceId && caller.scopeWorkspaceId)) && !daemonUpdateControlRequest(request)) {
      // Do not strand an already leased run while its daemon waits to update.
      // Only the credential that claimed the work gets this grace; a new login
      // cannot use it. The handler's existing fence still rechecks revocation.
      const runId = daemonRunRequestId(request)
      if (!runId) return daemonUpgradeResponse()
      const live = await pool.query(`SELECT 1 FROM agent_runs WHERE "deviceTokenId"=$1 AND "userId"=$2 AND id=$3
        AND "leaseExpiresAt">now() AND status IN ('preparing','running','waiting_input','finishing') LIMIT 1`, [caller.tokenId, caller.userId, runId])
      if (!live.rowCount) return daemonUpgradeResponse()
    }
    try {
      const run = () => deviceRequestCaller.run(caller, () => handler(request, ...args))
      // One fence per burst of statements (lib/db/device-scope.ts) unless its kill switch is on: then one per statement.
      return deploymentSwitch('deviceUnitFence') ? await withDeviceUnitFence(caller, run) : await withDeviceDatabaseAuthority(caller, run)
    } catch (error) {
      if (isDeviceAuthorityRevoked(error)) return unauthorized()
      // No fence connection: refuse rather than run unfenced. The daemon backs off on 5xx and keeps its session.
      if (isDeviceAuthorityError(error)) return Response.json({ error: 'deviceAuthorityUnavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '2' } })
      throw error
    }
  }
}
