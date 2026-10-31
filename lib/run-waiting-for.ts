import { isDeviceOnline } from '@mikka/protocol/device'

/** Scheduling metadata is private to the owner and relevant only before claim. */
export function runWaitingDeviceId(userId: string, run: {
  ownerId: string
  status: string
  deviceId: string | null
  lastSeenAt: Date | null
  deviceEnabled: boolean | null
}): string | undefined {
  return run.ownerId === userId && run.status === 'queued' && run.deviceId
    && (run.deviceEnabled === false || !isDeviceOnline(run.lastSeenAt)) ? run.deviceId : undefined
}
