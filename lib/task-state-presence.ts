import { deviceOnlineStates } from './device-presence'

/** Reuse gateway presence: a sleeping socket may be online after its HTTP heartbeat expired. */
export async function withTaskDevicePresence<T extends { deviceOffline: boolean; offlineDevice: { id: string; lastSeenAt: string | null } | null }>(rows: T[]): Promise<Omit<T, 'offlineDevice'>[]> {
  const online = await deviceOnlineStates(rows.flatMap(row => row.deviceOffline && row.offlineDevice ? [row.offlineDevice] : []))
  return rows.map(({ offlineDevice, ...row }) => ({ ...row, deviceOffline: row.deviceOffline && !(offlineDevice && online.get(offlineDevice.id)) }))
}
