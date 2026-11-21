/** Presence is already in `deviceOffline` (the device session columns); this only drops the retired column. */
export async function withTaskDevicePresence<T extends { deviceOffline: boolean; offlineDevice: { id: string; lastSeenAt: string | null } | null }>(rows: T[]): Promise<Omit<T, 'offlineDevice'>[]> {
  return rows.map(({ offlineDevice: _offlineDevice, ...row }) => row)
}
