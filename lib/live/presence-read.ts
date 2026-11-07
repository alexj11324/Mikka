import { devicePresenceGrant } from '../device-presence-grant'
import { liveGatewayConfig } from './scope'
import type { ListLiveRead } from './list-read'
import type { PresenceDevice } from './presence'

/** Reuse the home and owned device rows from the ordinary authenticated read.
 * Missing transport/proof stays explicit so a newer client retains fallback. */
export function withDevicePresence(live: ListLiveRead, devices: PresenceDevice[], env: Record<string, string | undefined> = process.env, now = Date.now()): ListLiveRead {
  if (!devices.length) return live
  const config = liveGatewayConfig(env)
  return { ...live, presence: config && live.workspaceId
    ? devicePresenceGrant({ ownerId: live.ownerId, workspaceId: live.workspaceId }, devices, config.secret, now)
    : null }
}
