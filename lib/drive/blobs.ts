import 'server-only'
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { artifactStorage, getArtifactObjectStream, putArtifactObject } from '@/lib/artifacts/storage'
import { DRIVE_MAX_FILE_BYTES } from './contract'

/**
 * Drive's blobs: the same object storage and the same sha256 convention the
 * artifacts already use, widened from one file per version to a tree of files
 * (ALE-32).
 *
 * Nothing here re-implements storage. `artifactStorage()` decides between the
 * bucket and an inline row exactly as it does for artifacts, and
 * `putArtifactObject` uploads with the byte length and `if-none-match: *` that
 * R2 needs. What Drive adds is that a key is derived from the owner and the
 * digest: the same bytes are stored once per person, however many volumes or
 * paths hold them, and never shared between people.
 *
 * Deduplicating across owners would be wrong, not merely cautious. A client
 * always sends the digests it wants in its manifest, so a digest is public to
 * whoever can address a volume; a table keyed by digest alone would let one
 * person name another person's digest and read bytes they never stored.
 */

export const DRIVE_STORAGE_PREFIX = 'drive/'

/** sha256 of the bytes, as the manifest and the blob table both spell it. */
export function driveSha256(bytes: Uint8Array<ArrayBuffer>): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * A content-addressed key, scoped to its owner. The two hex characters after
 * the owner fan objects across prefixes, because a bucket listing or a
 * lifecycle rule works per prefix and one flat namespace is slow to operate.
 */
export function driveStorageKey(ownerId: string, sha256: string): string {
  // The owner is a user id, which is opaque text; encode it so a key can never
  // grow a path separator or an empty segment out of it.
  return `${DRIVE_STORAGE_PREFIX}${encodeURIComponent(ownerId)}/${sha256.slice(0, 2)}/${sha256}`
}

export interface StoredDriveBlob { ownerId: string; sha256: string; sizeBytes: number }

/** The bytes behind a digest, streamed so a large file is not buffered whole. */
export async function readDriveBlobObject(ownerId: string, sha256: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  return getArtifactObjectStream(driveStorageKey(ownerId, sha256), signal)
}

/** The bytes are read into a buffer this module owns, never a shared one. */
export function driveBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes as Uint8Array<ArrayBuffer>
    : Uint8Array.from(bytes)
}

/**
 * Writes bytes into object storage and returns their digest and size for this
 * owner. The caller records the row in its own transaction, so the object and
 * the row commit together; an object without a row is harmless (a later write
 * of the same bytes re-puts it, and `if-none-match` makes that a 412 rather than
 * an overwrite), while a row without an object would be a dangling entry.
 */
export async function storeDriveBlob(ownerId: string, bytes: Uint8Array<ArrayBuffer>): Promise<StoredDriveBlob> {
  const sha256 = driveSha256(bytes), sizeBytes = bytes.byteLength
  if (sizeBytes > DRIVE_MAX_FILE_BYTES) throw new Error('driveBlobTooLarge')
  // The storage mode is process-wide configuration, so this is one decision, not one per byte.
  if (artifactStorage() === 'r2') await putArtifactObject(driveStorageKey(ownerId, sha256), bytes, 'application/octet-stream')
  return { ownerId, sha256, sizeBytes }
}

/** Record the digest's row for this owner, keeping the first row if it exists. */
export async function recordDriveBlob(client: Pick<PoolClient, 'query'>, blob: StoredDriveBlob, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  // Community installs and previews have no bucket: the bytes live in the row,
  // which is exactly the split the artifacts already use for their versions.
  const storageKey = artifactStorage() === 'inline' ? null : driveStorageKey(blob.ownerId, blob.sha256)
  await client.query(`INSERT INTO drive_blobs ("ownerId",sha256,"sizeBytes","storageKey","inlineContent")
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("ownerId",sha256) DO NOTHING`,
    [blob.ownerId, blob.sha256, blob.sizeBytes, storageKey, storageKey === null ? Buffer.from(bytes) : null])
}
