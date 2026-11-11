import 'server-only'
import type { Pool, PoolClient } from 'pg'
import {
  DRIVE_MAX_ENTRIES, driveScopeProblem, isVolumeId, manifestCanonicalText,
  type DriveManifestEntry, type DriveScope,
} from './contract'
import { createUlidFactory } from './ulid'

/**
 * Creating and reading a volume: the container the CAS writes into.
 *
 * A new volume is never empty in an unrepresentable way. It starts with one
 * version (`seq` 1) holding an empty manifest, and its head pointer names that
 * version, so every later write has a digest to compare against and a client
 * never has to special-case "no head yet".
 */

const digestOf = (entries: readonly DriveManifestEntry[], sha256: (text: string) => string) =>
  sha256(manifestCanonicalText(entries))

export class DriveVolumeError extends Error {
  readonly code: 'drive_volume_name_invalid' | 'drive_scope_invalid' | 'drive_volume_exists' | 'drive_not_found'
  readonly status: number
  constructor(code: DriveVolumeError['code'], status: number, options?: { cause?: unknown }) {
    super(code, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DriveVolumeError'
    this.code = code
    this.status = status
  }
}

export interface CreateDriveVolumeInput {
  driveScope: DriveScope
  /** The owner's user id, or the project id. */
  scopeId: string
  /** The person inside a `project-user` volume; omitted for every other scope. */
  scopeUserId?: string | null
  name: string
  workspaceId?: string | null
}
export interface DriveVolumeSummary {
  id: string
  driveScope: DriveScope
  scopeId: string
  scopeUserId: string | null
  name: string
  headVersionId: string
  headDigest: string
  entryCount: number
  totalBytes: number
  createdAt: Date
  updatedAt: Date
}

const VOLUME_NAME_MAX = 200
function volumeNameProblem(name: unknown): boolean {
  return typeof name !== 'string' || !name.trim() || name.trim().length > VOLUME_NAME_MAX
}

/** The empty tree's version id and digest, so a new volume has a real head. */
export function emptyVolumeHead(sha256: (text: string) => string): { digest: string } {
  return { digest: digestOf([], sha256) }
}

const nextVolumeId = createUlidFactory()
const nextVersionId = createUlidFactory()
export const newDriveVolumeId = () => `vol_${nextVolumeId()}`
export const newDriveVersionId = () => `vver_${nextVersionId()}`

/**
 * Creates a volume with its first, empty version.
 *
 * The unique index on (scope, scope id, scope user, name) is what actually
 * enforces "one name per scope"; this maps its violation to a typed error
 * instead of leaking a constraint name, so a caller can offer a rename.
 */
export async function createDriveVolume(
  database: { connect: Pool['connect'] },
  actor: { ownerId: string; authorName: string },
  input: CreateDriveVolumeInput,
  sha256: (text: string) => string,
): Promise<DriveVolumeSummary> {
  const scopeProblem = driveScopeProblem(input.driveScope, input.scopeId, input.scopeUserId ?? null)
  if (scopeProblem) throw new DriveVolumeError('drive_scope_invalid', 422)
  if (volumeNameProblem(input.name)) throw new DriveVolumeError('drive_volume_name_invalid', 422)

  const id = newDriveVolumeId(), versionId = newDriveVersionId(), name = input.name.trim()
  const digest = emptyVolumeHead(sha256).digest
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    try {
      await client.query(`INSERT INTO drive_volumes (id,"driveScope","scopeId","scopeUserId","ownerId","workspaceId",name,
          "headVersionId","headDigest","entryCount","totalBytes")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0)`,
        [id, input.driveScope, input.scopeId, input.scopeUserId ?? null, actor.ownerId, input.workspaceId ?? null, name, versionId, digest])
      await client.query(`INSERT INTO drive_volume_versions (id,"volumeId","ownerId",seq,kind,"fileCount","totalBytes",digest,manifest,"threadId","threadTitle","authorName")
        VALUES ($1,$2,$3,1,'autosave',0,0,$4,'[]'::jsonb,NULL,NULL,$5)`,
        [versionId, id, actor.ownerId, digest, actor.authorName])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      // Another volume of this scope already holds the name.
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505')
        throw new DriveVolumeError('drive_volume_exists', 409, { cause: error })
      throw error
    }
  } finally { client.release() }
  return { id, driveScope: input.driveScope, scopeId: input.scopeId, scopeUserId: input.scopeUserId ?? null, name,
    headVersionId: versionId, headDigest: digest, entryCount: 0, totalBytes: 0, createdAt: new Date(), updatedAt: new Date() }
}

/** The volumes of one scope, newest change first. Always filtered by owner. */
export async function listDriveVolumes(
  database: Pick<PoolClient, 'query'>,
  actor: { ownerId: string },
  scope: { driveScope: DriveScope; scopeId: string; scopeUserId?: string | null },
): Promise<DriveVolumeSummary[]> {
  const { rows } = await database.query<{
    id: string; driveScope: DriveScope; scopeId: string; scopeUserId: string | null; name: string
    headVersionId: string; headDigest: string; entryCount: number; totalBytes: string; createdAt: Date; updatedAt: Date
  }>(`SELECT id,"driveScope","scopeId","scopeUserId",name,"headVersionId","headDigest","entryCount","totalBytes","createdAt","updatedAt"
      FROM drive_volumes
      WHERE "ownerId"=$1 AND "driveScope"=$2 AND "scopeId"=$3 AND coalesce("scopeUserId",'')=coalesce($4,'')
      ORDER BY "updatedAt" DESC, id DESC`, [actor.ownerId, scope.driveScope, scope.scopeId, scope.scopeUserId ?? null])
  return rows.map(row => ({ ...row, totalBytes: Number(row.totalBytes) }))
}

/** One volume, or a typed 404. A volume of another owner is not found. */
export async function readDriveVolume(
  database: Pick<PoolClient, 'query'>,
  actor: { ownerId: string },
  volumeId: string,
): Promise<DriveVolumeSummary> {
  if (!isVolumeId(volumeId)) throw new DriveVolumeError('drive_not_found', 404)
  const { rows: [row] } = await database.query<{
    id: string; driveScope: DriveScope; scopeId: string; scopeUserId: string | null; name: string
    headVersionId: string; headDigest: string; entryCount: number; totalBytes: string; createdAt: Date; updatedAt: Date
  }>(`SELECT id,"driveScope","scopeId","scopeUserId",name,"headVersionId","headDigest","entryCount","totalBytes","createdAt","updatedAt"
      FROM drive_volumes WHERE id=$1 AND "ownerId"=$2`, [volumeId, actor.ownerId])
  if (!row) throw new DriveVolumeError('drive_not_found', 404)
  return { ...row, totalBytes: Number(row.totalBytes) }
}

export { DRIVE_MAX_ENTRIES }
