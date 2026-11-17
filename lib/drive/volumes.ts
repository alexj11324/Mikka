import 'server-only'
import type { Pool, PoolClient } from 'pg'
import {
  DRIVE_MAX_ENTRIES, driveScopeProblem, isVolumeId, manifestCanonicalText,
  type DriveManifestEntry, type DriveScope,
} from './contract'
import { createUlidFactory } from './ulid'
import type { DriveVolumeLocation } from './location'

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
  /** Account, Project or team Workspace selected by this storage scope. */
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
 * Folder names are unique within their Drive scope. For personal folders,
 * the selected workspace is part of that scope. A duplicate becomes a
 * typed error so the caller can offer a rename.
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
  scope: { driveScope: DriveScope; scopeId: string; scopeUserId?: string | null; workspaceId?: string },
  page?: { beforeId?: string; limit: number; archived?: boolean },
): Promise<DriveVolumeSummary[]> {
  const { rows } = await database.query<{
    id: string; driveScope: DriveScope; scopeId: string; scopeUserId: string | null; name: string
    headVersionId: string; headDigest: string; entryCount: number; totalBytes: string; createdAt: Date; updatedAt: Date
  }>(`SELECT id,"driveScope","scopeId","scopeUserId",name,"headVersionId","headDigest","entryCount","totalBytes","createdAt","updatedAt"
      FROM drive_volumes
      WHERE "ownerId"=$1 AND "driveScope"=$2 AND "scopeId"=$3 AND coalesce("scopeUserId",'')=coalesce($4,'')
        AND ($5::uuid IS NULL OR "workspaceId"=$5) AND ($6::text IS NULL OR id<$6)
        AND ("archivedAt" IS NOT NULL)=$8
      ORDER BY ${page ? 'id DESC' : '"updatedAt" DESC, id DESC'} LIMIT $7`,
  [actor.ownerId, scope.driveScope, scope.scopeId, scope.scopeUserId ?? null, scope.workspaceId ?? null, page?.beforeId ?? null, page?.limit ?? null, page?.archived ?? false])
  return rows.map(row => ({ ...row, totalBytes: Number(row.totalBytes) }))
}

export type OrganizationDriveVolume = {
  id: string; namespace: string; name: string; workspaceId: string; driveScope: DriveScope; projectId: string | null; userId: string | null
  automationId: null; description: null; archived: boolean; headVersionId: string; headDigest: string
  fileCount: number; totalBytes: number; headUpdatedAt: string
}

export type OrganizationVolumeRow = Omit<OrganizationDriveVolume, 'headUpdatedAt'> & { headUpdatedAt: Date }

/** Both the directory and an archive transition describe the same stored volume
 * and immutable head. Visibility and scope filters belong to the calling read or writer. */
export const organizationVolumeSelect = `SELECT v.id,v.name,v."ownerId" AS namespace,v."workspaceId",v."driveScope",
  CASE WHEN v."driveScope" IN ('project','project-user') THEN v."scopeId" END AS "projectId",
  CASE WHEN v."driveScope"='user' THEN v."scopeId" ELSE v."scopeUserId" END AS "userId",
  NULL::text AS "automationId",NULL::text AS description,v."archivedAt" IS NOT NULL AS archived,
  v."headVersionId",v."headDigest",v."entryCount" AS "fileCount",v."totalBytes"::float8 AS "totalBytes",h."createdAt" AS "headUpdatedAt"
  FROM drive_volumes v JOIN drive_volume_versions h ON h.id=v."headVersionId" AND h."volumeId"=v.id AND h."ownerId"=v."ownerId"`

export function serializeOrganizationVolume(volume: OrganizationVolumeRow): OrganizationDriveVolume {
  return { ...volume, headUpdatedAt: volume.headUpdatedAt.toISOString() }
}

/** Resolve only the location. Workspace admission, Organization attachment,
 * and the original volume and Project authorization still precede any data. */
export async function findDriveVolumeLocation(database: Pick<PoolClient, 'query'>, volumeId: string, reader: string, includeArchived = false): Promise<DriveVolumeLocation> {
  const { rows: [location] } = await database.query<DriveVolumeLocation>(`SELECT id AS "volumeId","workspaceId","driveScope",
      CASE WHEN "driveScope" IN ('project','project-user') THEN "scopeId" END AS "projectId"
    FROM drive_volumes WHERE id=$1 AND "workspaceId" IS NOT NULL AND ($3::boolean OR "archivedAt" IS NULL)
      AND ("driveScope" IN ('team-workspace','project') OR "ownerId"=$2 AND "driveScope" IN ('user','project-user'))`, [volumeId, reader, includeArchived])
  if (!location) throw new DriveVolumeError('drive_not_found', 404)
  return location
}

type VolumeReader = { ownerId: string; workspaceId?: string; driveScope?: DriveScope; scopeId?: string; scopeUserId?: string }

/** HTTP callers pin the complete location. An older Workspace-only caller
 * still means that person's own Drive in the selected tenant. */
function selectedVolume(actor: VolumeReader) {
  return [actor.driveScope ?? 'user', actor.scopeId ?? actor.ownerId, actor.scopeUserId ?? null]
}

/** One owner-authorized volume, or 404. The personal Files API additionally
 * requires the selected workspace and the owner's personal scope in this same read. */
export async function readDriveVolume(
  database: Pick<PoolClient, 'query'>,
  actor: VolumeReader,
  volumeId: string | undefined,
): Promise<DriveVolumeSummary> {
  if (!isVolumeId(volumeId)) throw new DriveVolumeError('drive_not_found', 404)
  const { rows: [row] } = await database.query<{
    id: string; driveScope: DriveScope; scopeId: string; scopeUserId: string | null; name: string
    headVersionId: string; headDigest: string; entryCount: number; totalBytes: string; createdAt: Date; updatedAt: Date
  }>(`SELECT id,"driveScope","scopeId","scopeUserId",name,"headVersionId","headDigest","entryCount","totalBytes","createdAt","updatedAt"
      FROM drive_volumes WHERE id=$1 AND "ownerId"=$2 AND "archivedAt" IS NULL
        AND (NOT $7::boolean OR ("workspaceId"=$3::uuid AND "driveScope"=$4 AND "scopeId"=$5
          AND "scopeUserId" IS NOT DISTINCT FROM $6::text))`,
    [volumeId, actor.ownerId, actor.workspaceId ?? null, ...selectedVolume(actor), 'workspaceId' in actor])
  if (!row) throw new DriveVolumeError('drive_not_found', 404)
  return { ...row, totalBytes: Number(row.totalBytes) }
}

type ArchiveDatabase = { connect: Pool['connect'] }
type ArchiveActor = VolumeReader & { workspaceId: string }

export function setPersonalDriveArchive(database: ArchiveDatabase, actor: ArchiveActor, volumeId: string | undefined, archived: boolean): Promise<boolean> {
  return withDriveArchive(database, actor, volumeId, archived, (_client, changed) => changed)
}

export function setOrganizationDriveArchive(database: ArchiveDatabase, actor: ArchiveActor, volumeId: string, archived: boolean) {
  return withDriveArchive(database, actor, volumeId, archived, async (client, changed) => {
    const { rows: [volume] } = await client.query<OrganizationVolumeRow>(`${organizationVolumeSelect} WHERE v.id=$1 AND v."ownerId"=$2`, [volumeId, actor.ownerId])
    if (!volume) throw new DriveVolumeError('drive_not_found', 404)
    return { changed, volume: serializeOrganizationVolume(volume) }
  })
}

/** The row lock serializes archive, its response and the content store's CAS. */
async function withDriveArchive<T>(
  database: ArchiveDatabase,
  actor: ArchiveActor,
  volumeId: string | undefined,
  archived: boolean,
  result: (client: PoolClient, changed: boolean) => T | Promise<T>,
): Promise<T> {
  if (!isVolumeId(volumeId)) throw new DriveVolumeError('drive_not_found', 404)
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    const { rows: [volume] } = await client.query<{ archived: boolean }>(
      `SELECT "archivedAt" IS NOT NULL AS archived FROM drive_volumes
       WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "driveScope"=$4 AND "scopeId"=$5
         AND "scopeUserId" IS NOT DISTINCT FROM $6::text FOR UPDATE`,
      [volumeId, actor.ownerId, actor.workspaceId, ...selectedVolume(actor)])
    if (!volume) throw new DriveVolumeError('drive_not_found', 404)
    const changed = archived !== volume.archived
    if (changed) await client.query(
      `UPDATE drive_volumes SET "archivedAt"=CASE WHEN $2::boolean THEN now() END, "updatedAt"=now() WHERE id=$1`,
      [volumeId, archived])
    const value = await result(client, changed)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

export { DRIVE_MAX_ENTRIES }
