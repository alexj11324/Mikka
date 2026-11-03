import { authenticateDevice } from './device-link'
import { deviceRequestCaller } from './device-request-context'
import { withDeviceDatabaseAuthority, withDeviceUnitFence, isDeviceAuthorityRevoked, isDeviceAuthorityError } from './db/device-scope'
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
