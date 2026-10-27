import { createHash } from 'node:crypto'

/** A workspace snapshot is refreshed daily or when its dependency inputs or
 * base image change. Callers must obtain the lockfiles from the same revision
 * that will populate the snapshot, not from the Bot machine's working tree. */
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function dependencyFingerprint(lockfiles: ReadonlyArray<{ path: string; contents: Uint8Array }>): string {
  const ordered = [...lockfiles].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (new Set(ordered.map(file => file.path)).size !== ordered.length) throw new Error('Duplicate lockfile path')
  const hash = createHash('sha256')
  for (const file of ordered) {
    const path = Buffer.from(file.path)
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(path.length)); hash.update(length); hash.update(path)
    length.writeBigUInt64BE(BigInt(file.contents.length)); hash.update(length); hash.update(file.contents)
  }
  return hash.digest('hex')
}

export function snapshotRefreshReason(snapshot: { dependencyFingerprint: string; sourceRevision: string; createdAt: Date } | null, current: { dependencyFingerprint: string; sourceRevision: string; now: Date }): 'missing' | 'dependencies' | 'source' | 'expired' | null {
  if (!snapshot) return 'missing'
  if (snapshot.dependencyFingerprint !== current.dependencyFingerprint) return 'dependencies'
  if (snapshot.sourceRevision !== current.sourceRevision) return 'source'
  const age = current.now.getTime() - snapshot.createdAt.getTime()
  // Invalid or future timestamps cannot safely establish freshness.
  if (!Number.isFinite(age) || age < 0 || age >= SNAPSHOT_MAX_AGE_MS) return 'expired'
  return null
}
