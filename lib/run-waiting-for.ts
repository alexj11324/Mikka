/** Scheduling metadata is private to the owner and relevant only before claim. */
export function runWaitingDeviceId(userId: string, run: {
  ownerId: string
  status: string
  deviceId: string | null
  deviceEnabled: boolean | null
  /** The device session is open (lib/device-presence.ts). */
  deviceOnline: boolean
}): string | undefined {
  return run.ownerId === userId && run.status === 'queued' && run.deviceId
    && (run.deviceEnabled === false || !run.deviceOnline) ? run.deviceId : undefined
}
