import 'server-only'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { DriveError } from './store'
import type { DriveFileLink, DriveFileLinkVisibility } from './contract'

type Database = Pick<PoolClient, 'query'>

/** A retry by the same person keeps its original link and chosen visibility. */
export async function createDriveFileLink(database: Database, volumeId: string, path: string, creator: string): Promise<DriveFileLink> {
  const { rows: [link] } = await database.query<DriveFileLink>(`INSERT INTO drive_file_links(id,"volumeId",path,"createdBy")
    SELECT $1,e."volumeId",e.path,$4 FROM drive_volume_entries e JOIN drive_volumes v ON v.id=e."volumeId"
    WHERE e."volumeId"=$2 AND e.path=$3 AND v."archivedAt" IS NULL FOR SHARE OF e,v
    ON CONFLICT ("volumeId",path,"createdBy") DO UPDATE SET "createdBy"=EXCLUDED."createdBy"
    RETURNING id,path,visibility`, [randomUUID(), volumeId, path, creator])
  if (!link) throw new DriveError('drive_not_found', 404)
  return link
}

export async function readOwnDriveFileLink(database: Database, volumeId: string, path: string, creator: string): Promise<DriveFileLink | null> {
  const { rows: [link] } = await database.query<DriveFileLink>(
    'SELECT id,path,visibility FROM drive_file_links WHERE "volumeId"=$1 AND path=$2 AND "createdBy"=$3', [volumeId, path, creator])
  return link ?? null
}

export async function updateDriveFileLink(database: Database, volumeId: string, id: string, creator: string, visibility: DriveFileLinkVisibility) {
  const { rows: [link] } = await database.query<DriveFileLink>(`UPDATE drive_file_links SET visibility=$4
    WHERE "volumeId"=$1 AND id=$2 AND "createdBy"=$3 RETURNING id,path,visibility`, [volumeId, id, creator, visibility])
  if (!link) throw new DriveError('drive_not_found', 404)
  return link
}

export async function revokeDriveFileLink(database: Database, volumeId: string, id: string, creator: string) {
  const result = await database.query('DELETE FROM drive_file_links WHERE "volumeId"=$1 AND id=$2 AND "createdBy"=$3', [volumeId, id, creator])
  if (!result.rowCount) throw new DriveError('drive_not_found', 404)
}

export type DriveFileBytes = { path: string; sha256: string; inlineContent: Buffer | null; sizeBytes: number }

/** Follow precisely this live entry in one snapshot. Withdrawing the link or
 * deleting its file cannot leave a separately resolved path usable. */
export function readLinkedDriveFile(database: Database, volumeId: string, id: string, reader: string, owner: string) {
  return database.query<DriveFileBytes>(`SELECT e.path,b.sha256,b."inlineContent",b."sizeBytes"
    FROM drive_file_links l JOIN drive_volume_entries e ON (e."volumeId",e.path)=(l."volumeId",l.path)
    JOIN drive_volumes v ON v.id=e."volumeId" AND v."ownerId"=e."ownerId"
    JOIN drive_blobs b ON b."ownerId"=e."ownerId" AND b.sha256=e.sha256 AND b."sizeBytes"=e."sizeBytes"
    WHERE l.id=$1 AND v.id=$2 AND v."ownerId"=$3 AND v."archivedAt" IS NULL
      AND (l."createdBy"=$4 OR l.visibility='org' AND v."driveScope" IN ('project','team-workspace'))`, [id, volumeId, owner, reader])
}
