import 'server-only'
import type { PoolClient } from 'pg'
import { MAX_SKILL_INSTRUCTIONS_LENGTH, MAX_SKILL_NAME_LENGTH } from '@mikka/protocol/skill'
import { skillDescription, skillName } from '../plugins/skill-metadata'
import { boundedDriveBytes, driveBytes, driveSha256, readDriveBlobObject } from './blobs'
import type { DriveScope, DriveSkillCursor, DriveSkillMetadata, DriveSkillPage } from './contract'
import { DriveError } from './store'

type Entry = DriveSkillCursor & { folder: string; versionId: string; sha256: string; sizeBytes: number; inlineContent: Buffer | null }

/** A page of current head entries in one already-authorized Drive. The volume
 * and bytes are read in one snapshot; immutable object keys remain readable
 * if a concurrent edit moves the head. No instructions are saved or executed. */
export async function listDriveSkills(database: Pick<PoolClient, 'query'>, actor: { ownerId: string },
  scope: { workspaceId: string; driveScope: DriveScope; scopeId: string; scopeUserId?: string },
  page: { after?: DriveSkillCursor; limit: number }, signal: AbortSignal): Promise<DriveSkillPage> {
  const { rows } = await database.query<Entry>(`SELECT v.id AS "volumeId", v.name AS folder, v."headVersionId" AS "versionId",
      e.path, e.sha256, e."sizeBytes", b."inlineContent"
    FROM drive_volumes v JOIN drive_volume_entries e ON e."volumeId"=v.id AND e."ownerId"=v."ownerId"
    JOIN drive_blobs b ON b."ownerId"=e."ownerId" AND b.sha256=e.sha256 AND b."sizeBytes"=e."sizeBytes"
    WHERE v."ownerId"=$1 AND v."workspaceId"=$2 AND v."driveScope"=$3 AND v."scopeId"=$4
      AND v."scopeUserId" IS NOT DISTINCT FROM $5::text AND v."archivedAt" IS NULL
      AND (e.path='SKILL.md' OR e.path LIKE '%/SKILL.md') AND e."sizeBytes" BETWEEN 1 AND $8
      AND ($6::text IS NULL OR (v.id,e.path) > ($6::text,$7::text))
    ORDER BY v.id,e.path LIMIT $9`,
    [actor.ownerId, scope.workspaceId, scope.driveScope, scope.scopeId, scope.scopeUserId ?? null,
      page.after?.volumeId ?? null, page.after?.path ?? null, MAX_SKILL_INSTRUCTIONS_LENGTH, page.limit + 1])
  const entries = rows.slice(0, page.limit)
  const skills: DriveSkillMetadata[] = []
  for (const entry of entries) {
    signal.throwIfAborted()
    const bytes = entry.inlineContent
      ? driveBytes(entry.inlineContent)
      : await boundedDriveBytes(await readDriveBlobObject(actor.ownerId, entry.sha256, signal), entry.sizeBytes)
    if (bytes.length !== entry.sizeBytes || driveSha256(bytes) !== entry.sha256) throw new DriveError('drive_blob_size_mismatch', 422)
    let body: string
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { continue }
    if (!body.trim() || body.includes('\0')) continue
    const name = skillName(body, entry.path.split('/').at(-2) || entry.folder).slice(0, MAX_SKILL_NAME_LENGTH)
    skills.push({ volumeId: entry.volumeId, path: entry.path, versionId: entry.versionId, name, description: skillDescription(body, '') })
  }
  const last = entries.at(-1)
  return { skills, nextCursor: rows.length > page.limit && last ? { volumeId: last.volumeId, path: last.path } : null }
}
