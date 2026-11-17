import 'server-only'
import type { PoolClient } from 'pg'
import { MAX_SKILL_INSTRUCTIONS_LENGTH, MAX_SKILL_NAME_LENGTH } from '@mikka/protocol/skill'
import { declaredSkillDescription, skillName } from '../plugins/skill-metadata'
import { boundedDriveBytes, driveBytes, driveSha256, readDriveBlobObject } from './blobs'
import type { DriveScope, DriveSkillCursor, DriveSkillMetadata, DriveSkillPage } from './contract'
import { DriveError } from './store'

type Entry = DriveSkillCursor & { ownerId: string; folder: string; versionId: string; sha256: string; sizeBytes: number; inlineContent: Buffer | null }

/** A page of current head entries in one already-authorized Drive. The volume
 * and bytes are read in one snapshot; immutable object keys remain readable
 * if a concurrent edit moves the head. No instructions are saved or executed. */
export async function listDriveSkills(database: Pick<PoolClient, 'query'>, actor: { ownerId: string },
  scope: { workspaceId: string; driveScope: DriveScope; scopeId: string; scopeUserId?: string },
  page: { after?: DriveSkillCursor; limit: number }, signal: AbortSignal): Promise<DriveSkillPage> {
  return readSkillPage(database, {
    predicate: `v."ownerId"=$5 AND v."workspaceId"=$6 AND v."driveScope"=$7
      AND v."scopeId"=$8 AND v."scopeUserId" IS NOT DISTINCT FROM $9::text`,
    parameters: [actor.ownerId, scope.workspaceId, scope.driveScope, scope.scopeId, scope.scopeUserId ?? null],
  }, page, signal)
}

/** The caller admits the volumes inside its current Organization read snapshot.
 * Keep the Markdown and any object-storage reads to the existing page size. */
export async function listOrganizationVolumeSkills(database: Pick<PoolClient, 'query'>, volumeIds: string[], signal: AbortSignal) {
  const skills: Pick<DriveSkillMetadata, 'name' | 'description'>[] = []
  if (!volumeIds.length) return skills
  const volumes = { predicate: 'v.id=ANY($5::text[])', parameters: [volumeIds] }
  let after: DriveSkillCursor | undefined
  do {
    const page = await readSkillPage(database, volumes, { after, limit: 25 }, signal)
    skills.push(...page.skills.map(({ name, description }) => ({ name, description })))
    after = page.nextCursor ?? undefined
  } while (after)
  return skills
}

async function readSkillPage(database: Pick<PoolClient, 'query'>, volumes: { predicate: string; parameters: unknown[] },
  page: { after?: DriveSkillCursor; limit: number }, signal: AbortSignal): Promise<DriveSkillPage> {
  const { rows } = await database.query<Entry>(`SELECT v.id AS "volumeId", v.name AS folder, v."headVersionId" AS "versionId",
      v."ownerId",e.path,e.sha256,e."sizeBytes",b."inlineContent"
    FROM drive_volumes v JOIN drive_volume_entries e ON e."volumeId"=v.id AND e."ownerId"=v."ownerId"
    JOIN drive_blobs b ON b."ownerId"=e."ownerId" AND b.sha256=e.sha256 AND b."sizeBytes"=e."sizeBytes"
    WHERE ${volumes.predicate} AND v."archivedAt" IS NULL
      AND (e.path='SKILL.md' OR e.path LIKE '%/SKILL.md') AND e."sizeBytes" BETWEEN 1 AND $3
      AND ($1::text IS NULL OR (v.id COLLATE "C",e.path COLLATE "C") > ($1::text,$2::text))
    ORDER BY v.id COLLATE "C",e.path COLLATE "C" LIMIT $4`,
    [page.after?.volumeId ?? null, page.after?.path ?? null, MAX_SKILL_INSTRUCTIONS_LENGTH, page.limit + 1, ...volumes.parameters])
  const entries = rows.slice(0, page.limit)
  const skills: DriveSkillMetadata[] = []
  for (const entry of entries) {
    signal.throwIfAborted()
    const bytes = entry.inlineContent
      ? driveBytes(entry.inlineContent)
      : await boundedDriveBytes(await readDriveBlobObject(entry.ownerId, entry.sha256, signal), entry.sizeBytes)
    if (bytes.length !== entry.sizeBytes || driveSha256(bytes) !== entry.sha256) throw new DriveError('drive_blob_size_mismatch', 422)
    let body: string
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { continue }
    if (!body.trim() || body.includes('\0')) continue
    const parts = entry.path.split('/')
    const canonical = parts.length === 3 && parts[0] === 'skills'
    const name = (canonical ? parts[1] : skillName(body, parts.at(-2) || entry.folder)).slice(0, MAX_SKILL_NAME_LENGTH)
    skills.push({ volumeId: entry.volumeId, path: entry.path, versionId: entry.versionId, name, description: declaredSkillDescription(body) })
  }
  const last = entries.at(-1)
  return { skills, nextCursor: rows.length > page.limit && last ? { volumeId: last.volumeId, path: last.path } : null }
}
