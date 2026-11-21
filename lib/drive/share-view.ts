import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PoolClient } from 'pg'
import { workspacePool } from '@/lib/workspace-db'
import { driveShareViewUrl, type DriveVolumeLocation } from './location'
import type { DriveFileLinkVisibility, DriveShareView } from './contract'
import { DriveError } from './store'

type Database = Pick<PoolClient, 'query'>
export type ShareLocation = DriveVolumeLocation

/** This locator yields no file or account data. The caller must acquire the
 * normal Workspace/Project lease and admit this exact volume before reading. */
export async function findShareLocation(database: Database, id: string, reader: string): Promise<ShareLocation> {
  const { rows: [row] } = await database.query<ShareLocation>(`SELECT v.id AS "volumeId",v."workspaceId",v."driveScope",
    CASE WHEN v."driveScope" IN ('project','project-user') THEN v."scopeId" END AS "projectId"
    FROM drive_file_links l JOIN drive_volumes v ON v.id=l."volumeId"
    WHERE l.id=$1 AND v."workspaceId" IS NOT NULL AND v."archivedAt" IS NULL
      AND (l."createdBy"=$2 OR l.visibility='org' AND v."driveScope" IN ('project','team-workspace'))`, [id, reader])
  if (!row) throw new DriveError('drive_not_found', 404)
  return row
}

const lifetime = 5 * 60_000
function signature(id: string, reader: string, digest: string, expires: number): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('Drive download signing is unconfigured')
  return createHmac('sha256', secret).update(JSON.stringify(['mikka-drive-download-v1', id, reader, digest, expires])).digest()
}

export function requireCurrentDownload(proof: string, id: string, reader: string, digest: string, now = Date.now()) {
  const parts = /^(\d{13})\.([a-f0-9]{64})$/.exec(proof)
  const expires = Number(parts?.[1])
  if (!parts || expires <= now || !timingSafeEqual(signature(id, reader, digest, expires), Buffer.from(parts[2], 'hex'))) {
    throw new DriveError('drive_not_found', 404)
  }
}

export function issueDriveDownload(url: string, subject: string, reader: string, sha256: string): DriveShareView['file'] {
  const expires = Date.now() + lifetime
  const download = new URLSearchParams({ download: `${expires}.${signature(subject, reader, sha256, expires).toString('hex')}` })
  return { type: 'url', url: `${url}?${download}`, expiresAt: new Date(expires).toISOString() }
}

/** Called while the original Workspace membership and any Project ACL are
 * held. APP selects the current entry and last change in one snapshot. WS
 * supplies the actual active Organization and membership through its own DB. */
export async function readShareView(database: Database, location: ShareLocation, id: string, owner: string, reader: string): Promise<DriveShareView> {
  const { rows: [entry] } = await database.query<{
    path: string; visibility: DriveFileLinkVisibility; authorName: string | null; manageable: boolean;
    versionId: string; versionCreatedAt: Date; sizeBytes: number; sha256: string; userId: string | null
  }>(`SELECT e.path,e."sizeBytes",e.sha256,l.visibility,nullif(trim(u.name),'') AS "authorName",l."createdBy"=$4 AS manageable,
      CASE WHEN v."driveScope"='user' THEN v."scopeId" ELSE v."scopeUserId" END AS "userId",
      history.id AS "versionId",history."createdAt" AS "versionCreatedAt"
    FROM drive_file_links l JOIN drive_volume_entries e ON (e."volumeId",e.path)=(l."volumeId",l.path)
    JOIN drive_volumes v ON v.id=e."volumeId" AND v."ownerId"=e."ownerId"
    JOIN "user" u ON u.id=l."createdBy"
    CROSS JOIN LATERAL (
      SELECT ver.id,ver."createdAt" FROM drive_volume_versions ver
      LEFT JOIN drive_volume_versions prev ON prev."volumeId"=ver."volumeId" AND prev.seq=ver.seq-1
      CROSS JOIN LATERAL (SELECT jsonb_build_array(jsonb_build_object('path',e.path,'mode',e.mode,'sha256',e.sha256,'sizeBytes',e."sizeBytes")) AS entry) current_file
      WHERE ver."volumeId"=e."volumeId" AND ver.manifest @> current_file.entry
        AND NOT coalesce(prev.manifest @> current_file.entry,false)
      ORDER BY ver.seq DESC LIMIT 1
    ) history
    WHERE l.id=$1 AND v.id=$2 AND v."ownerId"=$3 AND v."archivedAt" IS NULL
      AND (l."createdBy"=$4 OR l.visibility='org' AND v."driveScope" IN ('project','team-workspace'))`, [id, location.volumeId, owner, reader])
  if (!entry) throw new DriveError('drive_not_found', 404)
  const { rows: [organization] } = await workspacePool.query<{ id: string; name: string }>(`SELECT o.id,o.name
    FROM mikka_organization_workspaces w JOIN mikka_organizations o ON o.id=w."organizationId" AND o."archivedAt" IS NULL
    JOIN mikka_organization_members m ON (m."organizationId",m."userId")=(o.id,$2) AND m.status='active'
    WHERE w."workspaceId"=$1`, [location.workspaceId, reader])
  const url = driveShareViewUrl(id)
  return {
    type: 'file', id, path: entry.path, visibility: entry.visibility, url, orgName: organization?.name ?? null,
    authorName: entry.authorName, member: organization
      ? { orgId: organization.id, manageable: entry.manageable, projectId: location.projectId, userId: entry.userId, automationId: null } : null,
    versionId: entry.versionId, versionCreatedAt: entry.versionCreatedAt.toISOString(), sizeBytes: entry.sizeBytes,
    file: issueDriveDownload(url, id, reader, entry.sha256),
  }
}
