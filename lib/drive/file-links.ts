import 'server-only'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { DriveError } from './store'
import { driveFileLocation, driveFileLinkUrl, type DriveLocation } from './location'
import type { DriveFileLinkDetails, DriveFileLinkPage, DriveFileLinkVisibility, DriveWorkspaceFileLink, DriveWorkspaceFileLinkPage } from './contract'

type Database = Pick<PoolClient, 'query'>
type LinkRow = Omit<DriveFileLinkDetails, 'url'>

// All file-level reads and writes return the same stored row. A missing
// historical timestamp stays null, including after an idempotent create.
const linkFields = `l.id,l."volumeId",l.path,l.visibility,l."createdBy"=$2 AS manageable,
  (SELECT nullif(trim(u.name),'') FROM "user" u WHERE u.id=l."createdBy") AS "createdBy",
  to_jsonb(l)->>'createdAt' AS "createdAt"`

function describeLink(link: LinkRow, location: DriveLocation): DriveFileLinkDetails {
  return { ...link, url: driveFileLinkUrl(location, link.volumeId, link.id) }
}

/** A retry by the same person keeps its original link and chosen visibility. */
export async function createDriveFileLink(database: Database, volumeId: string, path: string, creator: string, location: DriveLocation): Promise<DriveFileLinkDetails> {
  const { rows: [link] } = await database.query<LinkRow>(`INSERT INTO drive_file_links AS l(id,"volumeId",path,"createdBy")
    SELECT $4,e."volumeId",e.path,$2 FROM drive_volume_entries e JOIN drive_volumes v ON v.id=e."volumeId"
    WHERE e."volumeId"=$1 AND e.path=$3 AND v."archivedAt" IS NULL FOR SHARE OF e,v
    ON CONFLICT ("volumeId",path,"createdBy") DO UPDATE SET "createdBy"=EXCLUDED."createdBy"
    RETURNING ${linkFields}`, [volumeId, creator, path, randomUUID()])
  if (!link) throw new DriveError('drive_not_found', 404)
  return describeLink(link, location)
}

export async function readOwnDriveFileLink(database: Database, volumeId: string, path: string, creator: string, location: DriveLocation): Promise<DriveFileLinkDetails | null> {
  const { rows: [link] } = await database.query<LinkRow>(
    `SELECT ${linkFields} FROM drive_file_links l WHERE l."volumeId"=$1 AND l."createdBy"=$2 AND l.path=$3`, [volumeId, creator, path])
  return link ? describeLink(link, location) : null
}

/** The enclosing Drive read holds its normal ACL. An opaque link ID orders
 * the page and conveys no authority to open or manage another person's link. */
export async function listDriveFileLinks(database: Database, volumeId: string, reader: string,
  page: { after: string | null; limit: number } | null, location: DriveLocation): Promise<DriveFileLinkPage> {
  const { rows } = await database.query<LinkRow>(`SELECT ${linkFields} FROM drive_file_links l JOIN drive_volumes v ON v.id=l."volumeId"
    WHERE l."volumeId"=$1 AND v."archivedAt" IS NULL AND ($3::uuid IS NULL OR l.id>$3)
      AND (l."createdBy"=$2 OR l.visibility='org' AND v."driveScope" IN ('project','team-workspace'))
    ORDER BY l.id LIMIT $4`, [volumeId, reader, page?.after ?? null, page ? page.limit + 1 : null])
  const links = page ? rows.slice(0, page.limit) : rows
  return { links: links.map(link => describeLink(link, location)), nextCursor: page && rows.length > page.limit ? links.at(-1)!.id : null }
}

/** Only Projects containing a potentially visible link need a canonical row
 * lock. This intermediate set is never exposed to the client. */
export async function fileLinkProjectIds(database: Database, workspaceId: string, reader: string) {
  const { rows } = await database.query<{ id: string }>(`SELECT DISTINCT v."scopeId" AS id
    FROM drive_volumes v JOIN drive_file_links l ON l."volumeId"=v.id
    WHERE v."workspaceId"=$1 AND v."archivedAt" IS NULL AND v."driveScope" IN ('project','project-user')
      AND (l."createdBy"=$2 OR l.visibility='org' AND v."driveScope"='project')`, [workspaceId, reader])
  return new Set(rows.map(row => row.id))
}

/** The tenant membership and selected canonical Project rows are held by the caller.
 * Recheck each Project's current ACL in the same APP statement as its link metadata. */
export async function listWorkspaceDriveFileLinks(database: Database, workspaceId: string, reader: string, projects: string[],
  page: { number: number; limit: number }): Promise<DriveWorkspaceFileLinkPage> {
  const directory = await listReadableFileDirectory(database, [workspaceId], reader,
    projects.map(id => ({ workspaceId, id })), page)
  return { ...directory, links: directory.links.map(({ workspaceId: _workspaceId, userId: _userId, ...link }) => link) }
}

type FileDirectoryLink = DriveWorkspaceFileLink & { workspaceId: string; userId: string | null }

/** Use the caller's held Workspace and canonical Project pairs. A Project from
 * one Workspace cannot admit an identically scoped volume in another one. */
export async function listReadableFileDirectory(database: Database, workspaces: string[], reader: string,
  projects: { workspaceId: string; id: string }[], page: { number: number; limit: number }) {
  const { rows: [result] } = await database.query<Omit<DriveWorkspaceFileLinkPage, 'links'> & { links: FileDirectoryLink[] }>(`WITH visible AS MATERIALIZED (
    SELECT l.id,l.path,l.visibility,
      v.id AS "volumeId",v.name AS "volumeName",v."workspaceId",v."driveScope",p.id::text AS "projectId",
      CASE WHEN v."driveScope"='user' THEN v."ownerId" WHEN v."driveScope"='project-user' THEN v."scopeUserId" END AS "userId",
      l."createdBy"=$2 AS manageable,
      l."createdBy" AS creator
    FROM drive_file_links l JOIN drive_volumes v ON v.id=l."volumeId"
    LEFT JOIN unnest($3::uuid[],$6::uuid[]) AS p(id,workspace_id) ON v."driveScope" IN ('project','project-user')
      AND p.id::text=v."scopeId" AND p.workspace_id=v."workspaceId"
    WHERE v."workspaceId"=ANY($1::uuid[]) AND v."archivedAt" IS NULL
      AND (l."createdBy"=$2 OR l.visibility='org' AND v."driveScope" IN ('project','team-workspace'))
      AND (
        (v."driveScope"='user' AND v."ownerId"=$2 AND v."scopeId"=$2 AND v."scopeUserId" IS NULL)
        OR (v."driveScope"='team-workspace' AND v."scopeId"=v."workspaceId"::text
          AND v."ownerId"='drive-team:'||v."workspaceId"::text AND v."scopeUserId" IS NULL)
        OR (p.id IS NOT NULL AND mikka_resource_acl_allowed('account',$2,v."workspaceId",'project',p.id,'canReadContent')
          AND ((v."driveScope"='project-user' AND v."scopeUserId"=$2 AND v."ownerId"=$2)
            OR (v."driveScope"='project' AND v."scopeUserId" IS NULL AND v."ownerId"='drive-project:'||v."workspaceId"::text||':'||p.id::text)))
      )
  ), tally AS (
    SELECT count(*)::integer AS total, greatest(1,ceil(count(*)::numeric/$5::integer)::integer) AS "pageCount" FROM visible
  ), selected AS (
    SELECT total,"pageCount",least($4::integer,"pageCount") AS page FROM tally
  ), batch AS (
    SELECT * FROM visible ORDER BY id LIMIT $5 OFFSET (SELECT (page-1)::bigint*$5 FROM selected)
  )
  SELECT total,page,"pageCount",coalesce((
    SELECT jsonb_agg((to_jsonb(batch)-'creator') || jsonb_build_object(
      'createdBy',nullif(trim(u.name),''),'createdAt',to_jsonb(l)->'createdAt',
      'changedAt',coalesce((to_jsonb(e)->>'changedAt')::timestamptz,history."createdAt")) ORDER BY batch.id)
    FROM batch JOIN "user" u ON u.id=batch.creator
    JOIN drive_file_links l ON l.id=batch.id
    JOIN drive_volume_entries e ON (e."volumeId",e.path)=(batch."volumeId",batch.path)
    LEFT JOIN LATERAL (
      -- Prior-version entries have no timestamp column. The latest transition to
      -- the current path, mode and bytes is its actual most recent change.
      SELECT ver."createdAt" FROM drive_volume_versions ver
      LEFT JOIN drive_volume_versions prev ON prev."volumeId"=ver."volumeId" AND prev.seq=ver.seq-1
      CROSS JOIN LATERAL (SELECT jsonb_build_array(jsonb_build_object('path',e.path,'mode',e.mode,'sha256',e.sha256,'sizeBytes',e."sizeBytes")) AS entry) head_entry
      WHERE to_jsonb(e)->>'changedAt' IS NULL AND ver."volumeId"=e."volumeId"
        AND ver.manifest @> head_entry.entry AND NOT coalesce(prev.manifest @> head_entry.entry,false)
      ORDER BY ver.seq DESC LIMIT 1
    ) history ON true
  ),'[]'::jsonb) AS links FROM selected`, [workspaces, reader, projects.map(p => p.id), page.number, page.limit, projects.map(p => p.workspaceId)])
  for (const link of result.links) {
    const location = driveFileLocation(link.workspaceId, link.driveScope, link.projectId)
    link.url = driveFileLinkUrl(location, link.volumeId, link.id)
  }
  return result
}

export async function updateDriveFileLink(database: Database, volumeId: string, id: string, creator: string, visibility: DriveFileLinkVisibility, location: DriveLocation) {
  const { rows: [link] } = await database.query<LinkRow>(`UPDATE drive_file_links AS l SET visibility=$4
    WHERE l."volumeId"=$1 AND l."createdBy"=$2 AND l.id=$3 RETURNING ${linkFields}`, [volumeId, creator, id, visibility])
  if (!link) throw new DriveError('drive_not_found', 404)
  return describeLink(link, location)
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
