import { authenticateDevice } from './device-link'
import { deviceRequestCaller } from './device-request-context'
import { withDeviceDatabaseAuthority, isDeviceAuthorityRevoked } from './db/device-scope'
import { pool } from './db'

/** Reuse each statement/transaction's write connection for the credential
 * lock. Long polls recheck whenever they query; no lock spans a wait or body. */
export function withDeviceRoute<Args extends unknown[]>(handler: (request: Request, ...args: Args) => Promise<Response>) {
  return async (request: Request, ...args: Args): Promise<Response> => {
    const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
    const caller = await authenticateDevice(request)
    if (!caller) return unauthorized()
    try {
      return await withDeviceDatabaseAuthority(caller, async () => {
        await pool.query('SELECT 1')
        return deviceRequestCaller.run(caller, () => handler(request, ...args))
      })
    } catch (error) {
      if (isDeviceAuthorityRevoked(error)) return unauthorized()
      throw error
    }
  }
}
