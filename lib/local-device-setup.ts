import type { LocalDevice } from '@mikka/protocol/bridge'

/**
 * What the desktop app does with this computer when it starts signed in
 * (Alex, 2026-11-02: installing the app makes this computer a device).
 * - none: its daemon answers as one of my devices, or is still connecting.
 * - install: its daemon answers but holds no device, or someone else's.
 * - repair: its daemon does not answer. Restart the service first and install
 *   only if that fails, so an existing device is not registered twice.
 */
export type LocalSetup = 'none' | 'install' | 'repair'

export function localSetupAction(local: LocalDevice, myDeviceIds: readonly string[]): LocalSetup {
  if (local.status === 'connecting') return 'none'
  if (local.status === 'online') return local.signedIn && local.deviceId && myDeviceIds.includes(local.deviceId) ? 'none' : 'install'
  return 'repair'
}
