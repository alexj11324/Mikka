import { createHash } from 'node:crypto'

export function shouldApplyLinearSnapshot(input: {
  remoteUpdatedAt: Date
  localUpdatedAt: Date
  appSyncedAt: Date | null
  linearUpdatedAt: Date | null
  force: boolean
}) {
  if (input.linearUpdatedAt && input.remoteUpdatedAt <= input.linearUpdatedAt) return false
  if (input.force) return input.remoteUpdatedAt > input.localUpdatedAt
  return input.appSyncedAt === null || input.localUpdatedAt <= input.appSyncedAt
}

export function linearDescriptionChanged(remoteDescription: string | null, syncedHash: string | null, localMarkdown: string) {
  const description = remoteDescription ?? ''
  if (!syncedHash) return description !== localMarkdown
  return createHash('sha256').update(description).digest('hex') !== syncedHash
}
