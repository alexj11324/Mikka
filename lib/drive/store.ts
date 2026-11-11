import 'server-only'
import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  DRIVE_MAX_ENTRIES, applyDriveChanges, conflictedDrivePaths, driveChangePaths, driveManifestProblem,
  driveWriteProblem, manifestCanonicalText, type DriveChange, type DriveManifestEntry, type DriveScope, type DriveWrite,
} from './contract'
import { createUlidFactory } from './ulid'

/**
 * Drive's write path: a compare-and-swap on the tree digest (ALE-33).
 *
 * This follows the pattern Mikka already uses to take a run or a task — the
 * same `BEGIN` / `SELECT … FOR UPDATE` / compare / write / `COMMIT` that
 * `lib/computer/claim.ts` and the Factory store use, and the same idempotency
 * receipt `lib/factory/monitor-cycle.db.test.ts` proves with ten replays. It is
 * the same idea as Capy's Drive write, with the naming kept Mikka's own: a
 * `driveScope`, not a Capy "scope"; a `volume`, not a "workspace".
 *
 * The invariant the whole feature rests on: a write either lands completely or
 * changes nothing. Every check happens under the volume row's lock, and every
 * refusal throws before any row is written.
 */

export class DriveError extends Error {
  readonly code: DriveErrorCode
  readonly status: number
  readonly detail?: DriveConflictDetail
  constructor(code: DriveErrorCode, status: number, detail?: DriveConflictDetail) {
    super(code)
    this.name = 'DriveError'
    this.code = code
    this.status = status
    if (detail) this.detail = detail
  }
}

export const DRIVE_ERROR_CODES = [
  'drive_not_found', 'drive_scope_invalid', 'drive_limit_exceeded', 'drive_version_conflict',
  'drive_replay_mismatch', 'drive_blob_unknown', 'drive_blob_size_mismatch', 'drive_manifest_invalid',
  'drive_write_invalid',
] as const
export type DriveErrorCode = (typeof DRIVE_ERROR_CODES)[number]

/**
 * What a conflict tells the caller. A bare 409 says only "you lost the race";
 * `headDigest` and `paths` say which tree to read and which entries differ, so
 * the client can re-read exactly those and retry instead of guessing. This is
 * the part Capy's Drive gets right and a plain optimistic-lock error does not.
 */
export interface DriveConflictDetail {
  /** The digest the client should base its next attempt on. */
  headDigest: string
  /** The version that digest names. */
  headVersionId: string
  /** The requested paths whose stored form differs from what the client sent. */
  paths: string[]
}

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex')

/** One digest over a whole request, so a replayed id can prove it is the same write. */
export function driveRequestDigest(write: DriveWrite): string {
  return sha256Hex(JSON.stringify([
    write.expectedDigest,
    write.changes.map(change => (change.op === 'delete'
      ? ['delete', change.path]
      : ['put', change.path, change.mode, change.sizeBytes, change.sha256])),
  ]))
}

export interface DriveVersionSummary {
  id: string
  seq: number
  kind: 'autosave' | 'checkpoint' | 'restore'
  fileCount: number
  totalBytes: number
  digest: string
  threadId: string | null
  threadTitle: string | null
  authorName: string
  restoredFromVersionId: string | null
  createdAt: Date
}

export interface DriveWriteResult {
  headVersionId: string
  headDigest: string
  seq: number
  entryCount: number
  totalBytes: number
  /** True when this call found an earlier receipt for the same mutation and did not write. */
  replayed: boolean
}

/** Who and where a write comes from: the audit columns a history reads. */
export interface DriveActor {
  ownerId: string
  authorName: string
  threadId?: string | null
  threadTitle?: string | null
}

type Database = Pick<Pool, 'connect'>

async function withTransaction<T>(database: Database, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

/** The head tree, read the same way a conflict report and a write both need it. */
async function readEntries(client: Pick<PoolClient, 'query'>, volumeId: string): Promise<DriveManifestEntry[]> {
  const { rows } = await client.query<{ path: string; mode: number; sizeBytes: number; sha256: string }>(
    'SELECT path,mode,"sizeBytes",sha256 FROM drive_volume_entries WHERE "volumeId"=$1 ORDER BY path', [volumeId])
  return rows.map(row => ({ path: row.path, mode: row.mode as DriveManifestEntry['mode'], sizeBytes: row.sizeBytes, sha256: row.sha256 }))
}

/**
 * The sizes the store recorded for these digests FOR THIS OWNER. A client's
 * stated size is never trusted, and another owner's digest is never visible:
 * a put naming a blob this owner never stored is `drive_blob_unknown`.
 */
async function blobSizes(client: Pick<PoolClient, 'query'>, ownerId: string, digests: readonly string[]): Promise<Map<string, number>> {
  if (!digests.length) return new Map()
  const { rows } = await client.query<{ sha256: string; sizeBytes: number }>(
    'SELECT sha256,"sizeBytes" FROM drive_blobs WHERE "ownerId"=$1 AND sha256 = ANY($2::text[])', [ownerId, [...new Set(digests)]])
  return new Map(rows.map(row => [row.sha256, row.sizeBytes]))
}

/**
 * Applies a write to a volume with a compare-and-swap on the tree digest.
 *
 * The order of the checks is deliberate and matches the rest of the codebase:
 *   1. the write itself is well formed (pure, before any lock);
 *   2. the volume exists for this owner and scope (a wrong owner looks absent,
 *      never forbidden, so a probe learns nothing);
 *   3. a receipt for this `mutationId` replays, or a different body wearing the
 *      same id is refused;
 *   4. the expected digest still is the head digest — otherwise a 409 naming
 *      the paths to re-read;
 *   5. the new tree is computed and validated, then written in one statement.
 *
 * Anything from step 4 on runs under the volume row's lock, so two concurrent
 * writes serialize on it instead of both passing the comparison.
 */
export async function applyDriveWrite(
  database: Database,
  scope: { ownerId: string; volumeId: string; driveScope?: DriveScope },
  actor: DriveActor,
  write: DriveWrite,
): Promise<DriveWriteResult> {
  const invalid = driveWriteProblem(write)
  if (invalid) throw new DriveError(invalid === 'no_changes' || invalid === 'too_many_changes' ? 'drive_limit_exceeded' : 'drive_write_invalid', 422)
  const requestDigest = driveRequestDigest(write)

  return withTransaction(database, async client => {
    // The row lock is the whole concurrency story: the digest it protects cannot
    // move between the comparison and the write that depends on it.
    const { rows: [volume] } = await client.query<{
      id: string; ownerId: string; driveScope: DriveScope; headVersionId: string; headDigest: string; entryCount: number; totalBytes: string
    }>('SELECT id,"ownerId","driveScope","headVersionId","headDigest","entryCount","totalBytes" FROM drive_volumes WHERE id=$1 FOR UPDATE', [scope.volumeId])
    if (!volume || volume.ownerId !== scope.ownerId) throw new DriveError('drive_not_found', 404)
    if (scope.driveScope && volume.driveScope !== scope.driveScope) throw new DriveError('drive_not_found', 404)

    // A replay answers with what the first attempt produced. Same id and same
    // body is the same write; same id and a different body is a bug in the
    // caller, and applying it would make "idempotent" mean nothing.
    const { rows: [receipt] } = await client.query<{ requestDigest: string; versionId: string; resultDigest: string }>(
      'SELECT "requestDigest","versionId","resultDigest" FROM drive_mutations WHERE "volumeId"=$1 AND "mutationId"=$2', [volume.id, write.mutationId])
    if (receipt) {
      if (receipt.requestDigest !== requestDigest) throw new DriveError('drive_replay_mismatch', 409)
      const { rows: [version] } = await client.query<{ seq: number; fileCount: number; totalBytes: string }>(
        'SELECT seq,"fileCount","totalBytes" FROM drive_volume_versions WHERE id=$1', [receipt.versionId])
      return { headVersionId: receipt.versionId, headDigest: receipt.resultDigest, seq: version?.seq ?? 0,
        entryCount: version?.fileCount ?? 0, totalBytes: Number(version?.totalBytes ?? 0), replayed: true }
    }

    const current = await readEntries(client, volume.id)
    // The stored head digest is what the CAS compares, and the entries are read
    // under the same lock, so the conflict report and the comparison agree.
    if (write.expectedDigest !== volume.headDigest) {
      throw new DriveError('drive_version_conflict', 409, {
        headDigest: volume.headDigest, headVersionId: volume.headVersionId,
        paths: conflictedDrivePaths(current, write.changes),
      })
    }
    // A put names bytes the server already hashed; the size comes from the blob
    // row, never from the request.
    const sizes = await blobSizes(client, volume.ownerId, write.changes.filter(change => change.op === 'put').map(change => change.sha256))
    const applied = applyDriveChanges(current, write.changes, digest => sizes.get(digest))
    if ('problem' in applied) throw new DriveError(applied.problem === 'blob_unknown' ? 'drive_blob_unknown' : 'drive_blob_size_mismatch', 422)
    const manifestProblem = driveManifestProblem(applied.manifest)
    if (manifestProblem) throw new DriveError(manifestProblem === 'too_many_entries' ? 'drive_limit_exceeded' : 'drive_manifest_invalid', manifestProblem === 'too_many_entries' ? 413 : 422)

    return commitVersion(client, volume, applied.manifest, actor, 'autosave', null, write.mutationId, requestDigest, write.expectedDigest)
  })
}

/**
 * Writes `manifest` as the volume's next version and moves both head pointers.
 *
 * One function for every kind of version — a normal write, a checkpoint and a
 * restore all land here, differing only in `kind` and `restoredFromVersionId`.
 * That is what keeps a restore from being a special case that could move a
 * pointer backwards: it can only ever *add* a version.
 */
async function commitVersion(
  client: PoolClient,
  volume: { id: string; ownerId: string },
  manifest: readonly DriveManifestEntry[],
  actor: DriveActor,
  kind: 'autosave' | 'checkpoint' | 'restore',
  restoredFromVersionId: string | null,
  mutationId: string | null,
  requestDigest: string | null,
  expectedDigest: string | null,
): Promise<DriveWriteResult> {
  const digest = manifestDigestOf(manifest)!
  const nextSeq = await nextSequence(client, volume.id)
  const versionId = versionIdFor()
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.sizeBytes, 0)

  // The entry rows and the version are written in the caller's transaction, so a
  // failure anywhere leaves the volume exactly as it was: this is what "a
  // refused write has no effect" means in practice.
  const { rows: held } = await client.query<{ path: string; mode: number; sizeBytes: number; sha256: string }>(
    'SELECT path,mode,"sizeBytes",sha256 FROM drive_volume_entries WHERE "volumeId"=$1 ORDER BY path', [volume.id])
  const currentPaths = new Set(held.map(row => row.path))
  const kept = new Map(held.map(row => [row.path, row]))
  const nextPaths = new Set(manifest.map(entry => entry.path))
  const removed = [...currentPaths].filter(path => !nextPaths.has(path))
  if (removed.length) await client.query('DELETE FROM drive_volume_entries WHERE "volumeId"=$1 AND path = ANY($2::text[])', [volume.id, removed])
  const changed = manifest.filter(entry => {
    const before = kept.get(entry.path)
    return !before || before.mode !== entry.mode || before.sha256 !== entry.sha256 || before.sizeBytes !== entry.sizeBytes
  })
  if (changed.length) {
    await client.query(`INSERT INTO drive_volume_entries ("volumeId","ownerId",path,mode,"sizeBytes",sha256)
      SELECT $1,$3,t.path,t.mode,t."sizeBytes",t.sha256 FROM jsonb_to_recordset($2::jsonb)
        AS t(path text,mode integer,"sizeBytes" integer,sha256 text)
      ON CONFLICT ("volumeId",path) DO UPDATE SET mode=EXCLUDED.mode,"sizeBytes"=EXCLUDED."sizeBytes",sha256=EXCLUDED.sha256`,
      [volume.id, JSON.stringify(changed), volume.ownerId])
  }
  await client.query(`INSERT INTO drive_volume_versions (id,"volumeId","ownerId",seq,kind,"fileCount","totalBytes",digest,manifest,"threadId","threadTitle","authorName","restoredFromVersionId")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [versionId, volume.id, volume.ownerId, nextSeq, kind, manifest.length, totalBytes, digest,
      JSON.stringify(manifest), actor.threadId ?? null, actor.threadTitle ?? null, actor.authorName, restoredFromVersionId])
  await client.query(`UPDATE drive_volumes SET "headVersionId"=$2,"headDigest"=$3,"entryCount"=$4,"totalBytes"=$5,"updatedAt"=now() WHERE id=$1`,
    [volume.id, versionId, digest, manifest.length, totalBytes])
  if (mutationId && requestDigest) {
    await client.query(`INSERT INTO drive_mutations ("volumeId","mutationId","requestDigest","versionId","expectedDigest","resultDigest")
      VALUES ($1,$2,$3,$4,$5,$6)`, [volume.id, mutationId, requestDigest, versionId, expectedDigest, digest])
  }
  return { headVersionId: versionId, headDigest: digest, seq: nextSeq, entryCount: manifest.length, totalBytes, replayed: false }
}

const digest = (entries: readonly DriveManifestEntry[]) => sha256Hex(manifestCanonicalText(entries))
/** The digest of a tree, for callers that already hold its entries. */
export function manifestDigestOf(entries: readonly DriveManifestEntry[]): string | undefined {
  const problem = driveManifestProblem(entries)
  return problem ? undefined : digest(entries)
}

async function nextSequence(client: Pick<PoolClient, 'query'>, volumeId: string): Promise<number> {
  const { rows: [row] } = await client.query<{ seq: number }>(
    'SELECT coalesce(max(seq),0)+1 AS seq FROM drive_volume_versions WHERE "volumeId"=$1', [volumeId])
  return row!.seq
}

const nextVersionId = createUlidFactory()
// A ULID keeps ids sortable and time-ordered; the volume and sequence are
// recorded on the row, so the id never encodes them.
const versionIdFor = () => `vver_${nextVersionId()}`

/** The head tree of a volume, for a read that does not need history. */
export async function readDriveHead(database: { query: Pool['query'] }, scope: { ownerId: string; volumeId: string }):
  Promise<{ headVersionId: string; headDigest: string; entries: DriveManifestEntry[] }> {
  const { rows: [volume] } = await database.query<{ ownerId: string; headVersionId: string; headDigest: string }>(
    'SELECT "ownerId","headVersionId","headDigest" FROM drive_volumes WHERE id=$1', [scope.volumeId])
  if (!volume || volume.ownerId !== scope.ownerId) throw new DriveError('drive_not_found', 404)
  const { rows } = await database.query<{ path: string; mode: number; sizeBytes: number; sha256: string }>(
    'SELECT path,mode,"sizeBytes",sha256 FROM drive_volume_entries WHERE "volumeId"=$1 ORDER BY path', [scope.volumeId])
  return { headVersionId: volume.headVersionId, headDigest: volume.headDigest,
    entries: rows.map(row => ({ path: row.path, mode: row.mode as DriveManifestEntry['mode'], sizeBytes: row.sizeBytes, sha256: row.sha256 })) }
}

/**
 * A volume's history, newest first (ALE-35).
 *
 * Every row carries `threadId` and `authorName`: a Drive history is read as
 * "which thread changed this, and who wrote it", and a version without that
 * provenance answers neither question.
 */
export async function readDriveHistory(
  database: Pick<Pool, 'query'>,
  actor: { ownerId: string },
  volumeId: string,
  options: { limit?: number; beforeId?: string } = {},
): Promise<DriveVersionSummary[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const { rows: [volume] } = await database.query<{ ownerId: string }>('SELECT "ownerId" FROM drive_volumes WHERE id=$1', [volumeId])
  if (!volume || volume.ownerId !== actor.ownerId) throw new DriveError('drive_not_found', 404)
  // A cursor is the last id already seen; ULIDs sort by time, so it doubles as
  // a stable page boundary without an offset that shifts under new writes.
  const { rows } = await database.query<{
    id: string; seq: number; kind: DriveVersionSummary['kind']; fileCount: number; totalBytes: string; digest: string
    threadId: string | null; threadTitle: string | null; authorName: string; restoredFromVersionId: string | null; createdAt: Date
  }>(`SELECT id,seq,kind,"fileCount","totalBytes",digest,"threadId","threadTitle","authorName","restoredFromVersionId","createdAt"
      FROM drive_volume_versions
      WHERE "volumeId"=$1 AND ($2::text IS NULL OR id < $2)
      ORDER BY id DESC LIMIT $3`, [volumeId, options.beforeId ?? null, limit])
  return rows.map(row => ({ ...row, totalBytes: Number(row.totalBytes) }))
}

/** One version and the tree it held, for a file diff or a preview of a restore. */
export async function readDriveVersion(
  database: Pick<Pool, 'query'>,
  actor: { ownerId: string },
  volumeId: string,
  versionId: string,
): Promise<DriveVersionSummary & { manifest: DriveManifestEntry[] }> {
  const { rows: [version] } = await database.query<{
    id: string; volumeId: string; seq: number; kind: DriveVersionSummary['kind']; fileCount: number; totalBytes: string; digest: string
    manifest: DriveManifestEntry[]; threadId: string | null; threadTitle: string | null; authorName: string
    restoredFromVersionId: string | null; createdAt: Date; ownerId: string
  }>(`SELECT v.id,v."volumeId",v.seq,v.kind,v."fileCount",v."totalBytes",v.digest,v.manifest,v."threadId",v."threadTitle",
        v."authorName",v."restoredFromVersionId",v."createdAt",d."ownerId"
      FROM drive_volume_versions v JOIN drive_volumes d ON d.id=v."volumeId"
      WHERE v.id=$1 AND v."volumeId"=$2`, [versionId, volumeId])
  if (!version || version.ownerId !== actor.ownerId) throw new DriveError('drive_not_found', 404)
  return { id: version.id, seq: version.seq, kind: version.kind, fileCount: version.fileCount,
    totalBytes: Number(version.totalBytes), digest: version.digest, threadId: version.threadId,
    threadTitle: version.threadTitle, authorName: version.authorName,
    restoredFromVersionId: version.restoredFromVersionId, createdAt: version.createdAt, manifest: version.manifest }
}

/**
 * Restores an earlier version by writing it FORWARD as a new version (ALE-35).
 *
 * "Restore brings back an earlier version as a new version, so nothing is
 * lost." This never moves a head pointer backwards and never deletes a version:
 * the tree becomes what it was, and the history keeps both what is now and what
 * it was before. The write is still a CAS on `expectedDigest`, so a restore
 * cannot silently overwrite a change made since the caller last looked.
 */
export async function restoreDriveVersion(
  database: { connect: Pool['connect'] },
  scope: { ownerId: string; volumeId: string },
  actor: DriveActor,
  input: { versionId: string; expectedDigest: string; mutationId: string },
): Promise<DriveWriteResult> {
  const requestDigest = sha256Hex(JSON.stringify(['restore', scope.volumeId, input.versionId, input.expectedDigest]))
  return withTransaction(database, async client => {
    const { rows: [volume] } = await client.query<{
      id: string; ownerId: string; headVersionId: string; headDigest: string
    }>('SELECT id,"ownerId","headVersionId","headDigest" FROM drive_volumes WHERE id=$1 FOR UPDATE', [scope.volumeId])
    if (!volume || volume.ownerId !== scope.ownerId) throw new DriveError('drive_not_found', 404)

    // A restore is idempotent for the same reason a write is.
    const { rows: [receipt] } = await client.query<{ requestDigest: string; versionId: string; resultDigest: string }>(
      'SELECT "requestDigest","versionId","resultDigest" FROM drive_mutations WHERE "volumeId"=$1 AND "mutationId"=$2', [volume.id, input.mutationId])
    if (receipt) {
      if (receipt.requestDigest !== requestDigest) throw new DriveError('drive_replay_mismatch', 409)
      const { rows: [version] } = await client.query<{ seq: number; fileCount: number; totalBytes: string }>(
        'SELECT seq,"fileCount","totalBytes" FROM drive_volume_versions WHERE id=$1', [receipt.versionId])
      return { headVersionId: receipt.versionId, headDigest: receipt.resultDigest, seq: version?.seq ?? 0,
        entryCount: version?.fileCount ?? 0, totalBytes: Number(version?.totalBytes ?? 0), replayed: true }
    }

    const { rows: [source] } = await client.query<{ manifest: DriveManifestEntry[]; digest: string }>(
      'SELECT manifest,digest FROM drive_volume_versions WHERE id=$1 AND "volumeId"=$2', [input.versionId, volume.id])
    if (!source) throw new DriveError('drive_not_found', 404)

    // The same CAS as a write: the caller's view must still be current.
    if (input.expectedDigest !== volume.headDigest) {
      const current = await readEntries(client, volume.id)
      const wanted = new Map(source.manifest.map(entry => [entry.path, entry]))
      const paths = [...new Set([...current.map(entry => entry.path), ...wanted.keys()])].filter(path => {
        const held = current.find(entry => entry.path === path), target = wanted.get(path)
        return target ? !held || held.sha256 !== target.sha256 || held.mode !== target.mode : Boolean(held)
      }).sort()
      throw new DriveError('drive_version_conflict', 409, { headDigest: volume.headDigest, headVersionId: volume.headVersionId, paths })
    }
    // The restored version is written forward as a new one that names its source.
    return commitVersion(client, volume, source.manifest, actor, 'restore', input.versionId,
      input.mutationId, requestDigest, input.expectedDigest)
  })
}

export { DRIVE_MAX_ENTRIES, driveChangePaths, type DriveChange, type DriveManifestEntry, type DriveScope, type DriveWrite }
