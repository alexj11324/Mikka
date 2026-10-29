import type { DaemonStatus } from '@mikka/protocol/daemon'
import type { LocalDevice } from '@mikka/protocol/bridge'

export const OFFLINE_DEVICE: LocalDevice = Object.freeze({
  status: 'offline',
  deviceId: null,
  workspaceId: null,
  signedIn: false,
  server: null,
})

export function toLocalDevice(status: DaemonStatus): LocalDevice {
  return {
    status: 'online',
    deviceId: status.deviceId,
    workspaceId: status.workspaceId,
    signedIn: status.signedIn,
    server: status.server,
  }
}
