import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { writeAllowed } from '@/lib/mobile-api'
import { ActionFailureError } from '@/lib/action-error'
import { WorkspaceError } from '@/lib/workspace-error'
import { accessibleProjectNames, withReadableProject } from '@/lib/project-access'
import { workspaceSelection } from '@/lib/workspace-selection'
import { findShareLocation, issueDriveDownload, readShareView, requireCurrentDownload } from './share-view'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { organizationSession } from '@/lib/enterprise/http'
import { workspacePool } from '@/lib/workspace-db'
import { workspaceListChanged } from '@/lib/live/lists'
import { DRIVE_MAX_CHANGES, DRIVE_MAX_FILE_BYTES, isDrivePath, isVolumeId, isVolumeVersionId } from './contract'
import { boundedDriveBytes, driveBytes, driveSha256, readDriveBlobObject, recordDriveBlob, storeDriveBlob } from './blobs'
import { applyDriveWrite, DriveError, readDriveFileHistory, readDriveHistory, readDriveVersion, restoreDriveVersion } from './store'
import { createDriveVolume, findDriveVolumeLocation, listDriveVolumes, readDriveVolume, setOrganizationDriveArchive, setPersonalDriveArchive } from './volumes'
import { driveFileLocation, organizationDriveVersionFileUrl } from './location'
import { driveErrorBody, driveErrorResponse } from './http'
import { listDriveSkills } from './skills'
import { createDriveFileLink, fileLinkProjectIds, listDriveFileLinks, listWorkspaceDriveFileLinks, readLinkedDriveFile, readOwnDriveFileLink, revokeDriveFileLink, updateDriveFileLink, type DriveFileBytes } from './file-links'

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const mutationId = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)
const versionId = z.string().refine(isVolumeVersionId)
const write = z.object({ expectedDigest: digest, mutationId, changes: z.array(z.discriminatedUnion('op', [
  z.object({ op: z.literal('put'), path: z.string().refine(isDrivePath), mode: z.union([z.literal(0o644), z.literal(0o755)]), sha256: digest, sizeBytes: z.number().int().min(0).max(DRIVE_MAX_FILE_BYTES) }).strict(),
  z.object({ op: z.literal('delete'), path: z.string().refine(isDrivePath) }).strict(),
])).min(1).max(DRIVE_MAX_CHANGES) }).strict()
const restore = z.object({ versionId, expectedDigest: digest, mutationId }).strict()
const organizationRestore = restore.omit({ mutationId: true })

function organizationManifest(volumeId: string, version: Awaited<ReturnType<typeof readDriveVersion>>) {
  return { versionId: version.id, volumeId, digest: version.digest, parentDigest: version.parentDigest,
    entries: version.manifest, fileCount: version.fileCount, totalBytes: version.totalBytes }
}

type Operation = 'scopes' | 'volumes' | 'volume' | 'write' | 'upload' | 'file' | 'history' | 'version' | 'restore' | 'archive' | 'unarchive' | 'links' | 'link' | 'workspaceLinks' | 'shareView' | 'organizationFileHistory' | 'organizationVersionFile'
type Params = { volumeId?: string; versionId?: string; sha256?: string; shareId?: string; organizationId?: string }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers })

async function body(request: Request) {
  return JSON.parse(new TextDecoder().decode(await boundedDriveBytes(request.body, 16 * 1024 * 1024))) as unknown
}

function fileLinkPage(search: URLSearchParams) {
  return { limit: z.coerce.number().int().min(1).max(100).parse(search.get('limit') ?? '50'),
    after: search.has('after') ? z.uuid().parse(search.get('after')) : null }
}

/** First HTTP surface over the existing volume, CAS and object-store implementation. */
export async function driveResponse(request: Request, operation: Operation, params: Params = {}): Promise<Response> {
  const session = params.organizationId ? await organizationSession(request, params.organizationId) : await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return json({ error: 'authRequired' }, 401)
  if (request.method !== 'GET' && !writeAllowed(request)) return json({ error: 'originNotAllowed' }, 403)
  try {
    const search = new URL(request.url).searchParams
    const viewId = operation === 'shareView' ? z.uuid().parse(params.shareId) : null
    if (viewId && (params.organizationId ? search.size !== 0 : [...search.keys()].some(key => key !== 'download'))) throw new DriveError('drive_write_invalid', 400)
    let located = viewId ? await findShareLocation(pool, viewId, session.user.id) : null
    const organizationArchive = !!params.organizationId && (operation === 'archive' || operation === 'unarchive')
    const organizationVolumeOperation = params.organizationId && (operation === 'version' || operation === 'history' || operation === 'restore' || operation === 'links')
    if ((organizationArchive || organizationVolumeOperation) && search.size) throw new DriveError('drive_write_invalid', 400)
    const versionFile = operation === 'organizationVersionFile'
      ? { versionId: versionId.parse(params.versionId), sha256: digest.parse(params.sha256), organizationId: z.uuid().parse(params.organizationId) } : null
    if (versionFile && (search.size > 1 || search.size === 1 && !search.has('download'))) throw new DriveError('drive_write_invalid', 400)
    let historyPath: string | undefined
    if (operation === 'organizationFileHistory') {
      if ([...search.keys()].some(key => key !== 'path') || search.getAll('path').length !== 1) throw new DriveError('drive_write_invalid', 400)
      historyPath = z.string().refine(isDrivePath).parse(search.get('path'))
    }
    if (historyPath !== undefined || organizationArchive || organizationVolumeOperation || versionFile) {
      located = await findDriveVolumeLocation(pool, z.string().refine(isVolumeId).parse(params.volumeId), session.user.id, organizationArchive)
    }
    const workspaceId = located?.workspaceId ?? z.uuid().parse(search.get('workspaceId')).toLowerCase()
    if (located) {
      const selected = workspaceSelection(request.headers)
      if (selected.present && selected.workspaceId !== workspaceId) throw new DriveError('drive_not_found', 404)
    }
    if (operation === 'workspaceLinks') {
      if (search.has('driveScope') || search.has('projectId') || search.has('view') || search.has('after')) throw new DriveError('drive_write_invalid', 400)
      const page = { number: z.coerce.number().int().min(1).max(2_147_483_647).parse(search.get('page') ?? '1'),
        limit: z.coerce.number().int().min(1).max(100).parse(search.get('limit') ?? '50') }
      return await withTaskWorkspace(session.user, workspaceId, async (workspace, tx) => {
        if (workspace.kind !== 'team') throw new DriveError('drive_not_found', 404)
        const candidates = await fileLinkProjectIds(pool, workspaceId, session.user.id)
        const projects = candidates.size ? await accessibleProjectNames(session.user, workspaceId, tx, candidates) : []
        return json(await listWorkspaceDriveFileLinks(pool, workspaceId, session.user.id, projects.map(project => project.id), page))
      })
    }
    const selection = located ? (located.driveScope === 'project' || located.driveScope === 'team-workspace' ? located.driveScope : null) : search.get('driveScope')
    if (selection !== null && selection !== 'project' && selection !== 'team-workspace') return json({ error: 'drive_write_invalid' }, 400)
    const sharedProject = selection === 'project'
    const teamFiles = selection === 'team-workspace'
    if (teamFiles && search.has('projectId')) return json({ error: 'drive_write_invalid' }, 400)
    const view = search.get('view')
    if (view !== null && (view !== 'skills' || operation !== 'volumes' || request.method !== 'GET')) return json({ error: 'drive_write_invalid' }, 400)
    if (operation === 'scopes') {
      return await withTaskWorkspace(session.user, workspaceId, async (workspace, tx) => {
        if (teamFiles) return json({ scopes: workspace.kind === 'team' ? [{ driveScope: 'team-workspace', workspaceId }] : [] })
        const projects = await accessibleProjectNames(session.user, workspaceId, tx)
        if (sharedProject) return json({ scopes: projects.map(project => ({
          driveScope: 'project', workspaceId, projectId: project.id, name: project.name,
        })) })
        return json({ scopes: [
          { driveScope: 'user', workspaceId },
          ...projects.map(project => ({ driveScope: 'project-user', workspaceId, projectId: project.id, name: project.name })),
        ] })
      })
    }
    let changed = false
    const projectId = located?.projectId ?? (search.has('projectId') ? z.uuid().parse(search.get('projectId')).toLowerCase() : undefined)
    if (sharedProject && !projectId) return json({ error: 'drive_write_invalid' }, 400)
    // A project names its own storage namespace. A member's existing private bytes and
    // versions never move into it, even when they have the same digest.
    const storage = sharedProject || teamFiles ? { workspaceId, projectId } : undefined
    const storageOwner = teamFiles ? `drive-team:${workspaceId}` : sharedProject ? `drive-project:${workspaceId}:${projectId}` : session.user.id
    const scope = teamFiles
      ? { driveScope: 'team-workspace' as const, scopeId: workspaceId }
      : sharedProject && projectId
      ? { driveScope: 'project' as const, scopeId: projectId }
      : projectId
      ? { driveScope: 'project-user' as const, scopeId: projectId, scopeUserId: session.user.id }
      : { driveScope: 'user' as const, scopeId: session.user.id }
    const actor = { ownerId: storageOwner, authorName: session.user.name, workspaceId, ...scope }
    const location = driveFileLocation(workspaceId, scope.driveScope, projectId)
    const serve = async () => {
      if (view === 'skills') {
        if (search.has('threadId')) return json({ error: 'drive_write_invalid' }, 400)
        const afterVolume = search.get('afterVolume')
        const afterPath = search.get('afterPath')
        if ((afterVolume === null) !== (afterPath === null)) return json({ error: 'drive_write_invalid' }, 400)
        const after = afterVolume === null ? undefined : {
          volumeId: z.string().refine(isVolumeId).parse(afterVolume), path: z.string().refine(isDrivePath).parse(afterPath),
        }
        const limit = z.coerce.number().int().min(1).max(25).parse(search.get('limit') ?? '25')
        return json(await listDriveSkills(pool, actor, { ...scope, workspaceId }, { after, limit }, request.signal))
      }
      if (operation === 'volumes') {
        if (request.method === 'POST') {
          const input = z.object({ name: z.string().trim().min(1).max(200) }).strict().parse(await body(request))
          const volume = await createDriveVolume(pool, actor, { ...input, workspaceId, ...scope }, text => createHash('sha256').update(text).digest('hex'))
          changed = true
          return json({ volume }, 201)
        }
        const limit = z.coerce.number().int().min(1).max(100).parse(search.get('limit') ?? '50')
        const before = search.has('before') ? z.string().refine(isVolumeId).parse(search.get('before')) : null
        const archived = z.enum(['true', 'false']).parse(search.get('archived') ?? 'false') === 'true'
        const result = await listDriveVolumes(pool, actor, { ...scope, workspaceId }, { limit: limit + 1, beforeId: before ?? undefined, archived })
        const volumes = result.slice(0, limit)
        return json({ volumes, nextCursor: result.length > limit ? volumes.at(-1)!.id : null })
      }
      if (operation === 'archive' || operation === 'unarchive') {
        const archived = operation === 'archive'
        if (organizationArchive && located) {
          const result = await setOrganizationDriveArchive(pool, actor, located.volumeId, archived)
          changed = result.changed
          return json(result.volume)
        }
        changed = await setPersonalDriveArchive(pool, actor, params.volumeId, archived)
        return json({ archived })
      }
      const volume = await readDriveVolume(pool, actor, located?.volumeId ?? params.volumeId)
      if (located && viewId && !params.organizationId && !search.has('download')) return json(await readShareView(pool, located, viewId, actor.ownerId, session.user.id))
      if (historyPath !== undefined) {
        const versions = await readDriveFileHistory(pool, actor, volume.id, historyPath, { limit: null })
        return json(versions.flatMap(v => v.file ? [{
          versionId: v.id, sha256: v.file.sha256, sizeBytes: v.file.sizeBytes, createdAt: v.createdAt,
          threadTitle: v.threadTitle, authorName: v.authorName,
        }] : []))
      }
      if (operation === 'links') {
        if (request.method === 'POST') {
          const { path } = z.object({ path: z.string().refine(isDrivePath) }).strict().parse(await body(request))
          const link = await createDriveFileLink(pool, volume.id, path, session.user.id, location)
          return json(params.organizationId ? link : { link })
        }
        if (search.has('path')) {
          const path = z.string().refine(isDrivePath).parse(search.get('path'))
          return json({ link: await readOwnDriveFileLink(pool, volume.id, path, session.user.id, location) })
        }
        const page = await listDriveFileLinks(pool, volume.id, session.user.id, params.organizationId ? null : fileLinkPage(search), location)
        return json(params.organizationId ? page.links : page)
      }
      const linkId = viewId ?? (operation === 'link' ? z.uuid().parse(params.shareId) : null)
      if (linkId && request.method === 'PATCH') {
        const { visibility } = z.object({ visibility: z.enum(['private', 'org']) }).strict().parse(await body(request))
        if (visibility === 'org' && !sharedProject && !teamFiles) throw new DriveError('drive_scope_invalid', 422)
        const link = await updateDriveFileLink(pool, volume.id, linkId, session.user.id, visibility, location)
        return json(params.organizationId ? link : { link })
      }
      if (linkId && request.method === 'DELETE') {
        await revokeDriveFileLink(pool, volume.id, linkId, session.user.id)
        return params.organizationId ? new Response(null, { status: 204, headers }) : json({ revoked: true })
      }
      if (operation === 'volume') {
        // Read an immutable manifest named by the head receipt, so a concurrent
        // write cannot mix an old digest with a newer mutable entry tree.
        const version = await readDriveVersion(pool, actor, volume.id, volume.headVersionId)
        return json({ volume, head: { headVersionId: version.id, headDigest: version.digest, entries: version.manifest } })
      }
      if (operation === 'history') {
        if (params.organizationId) {
          const versions = await readDriveHistory(pool, actor, volume.id, { limit: null })
          return json(versions.map(({ id, kind, fileCount, totalBytes, createdAt, threadId, threadTitle, authorName }) =>
            ({ id, volumeId: volume.id, kind, fileCount, totalBytes, createdAt, threadId, threadTitle, authorName })))
        }
        const limit = z.coerce.number().int().min(1).max(100).parse(search.get('limit') ?? '50')
        const beforeId = search.has('before') ? versionId.parse(search.get('before')) : undefined
        const options = { limit: limit + 1, beforeId }
        const versions = search.has('path')
          ? await readDriveFileHistory(pool, actor, volume.id, z.string().refine(isDrivePath).parse(search.get('path')), options)
          : await readDriveHistory(pool, actor, volume.id, options)
        const page = versions.slice(0, limit)
        return json({ versions: page, nextCursor: versions.length > limit ? page.at(-1)!.id : null })
      }
      if (operation === 'version') {
        const version = await readDriveVersion(pool, actor, volume.id, versionId.parse(params.versionId))
        return json(params.organizationId ? organizationManifest(volume.id, version) : { version })
      }
      if (operation === 'write') {
        const input = write.parse(await body(request))
        const digests = [...new Set(input.changes.flatMap(change => change.op === 'put' ? [change.sha256] : []))]
        if (digests.length) {
          const admitted = await pool.query<{ sha256: string }>(`SELECT sha256 FROM drive_blob_admissions
            WHERE "ownerId"=$1 AND "workspaceId"=$2 AND sha256=ANY($3::text[])`, [actor.ownerId, workspaceId, digests])
          if (admitted.rows.length !== digests.length) throw new DriveError('drive_blob_unknown', 422)
        }
        const result = await applyDriveWrite(pool, { ownerId: actor.ownerId, volumeId: volume.id, driveScope: scope.driveScope }, actor, input)
        changed = !result.replayed
        return json(result)
      }
      if (operation === 'restore') {
        const input = (params.organizationId ? organizationRestore : restore).parse(await body(request))
        const result = await restoreDriveVersion(pool, { ownerId: actor.ownerId, volumeId: volume.id }, actor, input)
        changed = !result.replayed
        if (!params.organizationId) return json(result)
        const version = await readDriveVersion(pool, actor, volume.id, result.headVersionId)
        return json(organizationManifest(volume.id, version))
      }
      if (operation === 'upload') {
        const content = await boundedDriveBytes(request.body, DRIVE_MAX_FILE_BYTES)
        const blob = await storeDriveBlob(actor.ownerId, content, storage)
        await recordDriveBlob(pool, blob, content)
        await pool.query(`INSERT INTO drive_blob_admissions("ownerId",sha256,"workspaceId") VALUES($1,$2,$3)
          ON CONFLICT("ownerId",sha256,"workspaceId") DO NOTHING`, [actor.ownerId, blob.sha256, workspaceId])
        return json({ sha256: blob.sha256, sizeBytes: blob.sizeBytes }, 201)
      }
      // A link always follows the current live path. Resolve its visibility, path and
      // content in the same snapshot, still under the original Workspace/Project ACL.
      if (linkId && (search.has('path') || search.has('versionId'))) throw new DriveError('drive_write_invalid', 400)
      const path = linkId || versionFile ? null : z.string().refine(isDrivePath).parse(search.get('path'))
      const selectedVersion = versionFile?.versionId ?? (search.has('versionId') ? versionId.parse(search.get('versionId')) : volume.headVersionId)
      // Both issuance and redemption run under current tenant and Project access.
      const subject = versionFile && JSON.stringify(['version-file', versionFile.organizationId, volume.id, selectedVersion])
      const download = search.get('download')
      const issueUrl = subject !== null && download === null
      if (versionFile && subject && download !== null) requireCurrentDownload(download, subject, session.user.id, versionFile.sha256)
      const { rows: [blob] } = linkId ? await readLinkedDriveFile(pool, volume.id, linkId, session.user.id, actor.ownerId)
        : await pool.query<DriveFileBytes>(
          `SELECT entry->>'path' AS path,b.sha256,CASE WHEN $6::boolean THEN b."inlineContent" END AS "inlineContent",b."sizeBytes"
           FROM drive_volume_versions v JOIN drive_volumes d ON d.id = v."volumeId"
           CROSS JOIN LATERAL jsonb_array_elements(v.manifest) AS entry
           JOIN drive_blobs b ON b.sha256 = entry->>'sha256' AND d."ownerId" = b."ownerId"
           WHERE v.id = $1 AND v."volumeId" = $2 AND d."ownerId" = $3 AND d."archivedAt" IS NULL
             AND entry->>($4::text) = $5 AND entry->'sizeBytes' = to_jsonb(b."sizeBytes")
           ORDER BY entry->>'path' COLLATE "C" LIMIT 1`, [selectedVersion, volume.id, actor.ownerId, versionFile ? 'sha256' : 'path', versionFile?.sha256 ?? path, !issueUrl])
      if (!blob) throw new DriveError('drive_not_found', 404)
      if (versionFile && subject && issueUrl) {
        const target = organizationDriveVersionFileUrl(versionFile.organizationId, volume.id, selectedVersion, blob.sha256)
        return json(issueDriveDownload(target, subject, session.user.id, blob.sha256))
      }
      if (viewId) requireCurrentDownload(search.get('download') ?? '', viewId, session.user.id, blob.sha256)
      if (blob.inlineContent && driveSha256(driveBytes(blob.inlineContent)) !== blob.sha256) throw new DriveError('drive_blob_size_mismatch', 422)
      const content = blob.inlineContent ? driveBytes(blob.inlineContent) : await readDriveBlobObject(actor.ownerId, blob.sha256, request.signal)
      return new Response(content, { headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(blob.sizeBytes),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(blob.path.split('/').at(-1)!)}` } })
    }
    const authorized = () => projectId
      ? withReadableProject(session.user, workspaceId, projectId, serve, sharedProject && request.method !== 'GET' && !['links', 'link', 'shareView'].includes(operation) ? 'canSteer' : 'canReadContent')
      : withTaskWorkspace(session.user, workspaceId, async workspace => {
        if (teamFiles && workspace.kind !== 'team') return json({ error: 'drive_not_found' }, 404)
        return serve()
      })
    const organizationId = params.organizationId
    const response = organizationId ? await withTaskWorkspace(session.user, workspaceId, async workspace => {
      // The original Workspace lease pins its attachment. Lock the active Organization
      // and its member before the canonical Project and content ACL are acquired.
      const membership = await workspacePool.query(`SELECT 1 FROM mikka_organization_workspaces a
        JOIN mikka_organizations o ON o.id=a."organizationId" AND o."archivedAt" IS NULL
        JOIN mikka_organization_members m ON m."organizationId"=o.id AND m."userId"=$3 AND m.status='active'
        WHERE a."workspaceId"=$1 AND a."organizationId"=$2 FOR SHARE OF o,m`, [workspaceId, organizationId, session.user.id])
      if (workspace.kind !== 'team' || !membership.rowCount) throw new DriveError('drive_not_found', 404)
      return projectId ? authorized() : serve()
    }) : await authorized()
    // Both the file mutation and its membership lease have finished. The
    // existing invalidation path resolves recipients afresh and carries no content.
    if (changed) await workspaceListChanged(pool, workspaceId, ['workspace_settings'])
    return response
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: 'drive_write_invalid' }, 400)
    if (error instanceof ActionFailureError && ['workspaceAccessDenied', 'projectNotFound', 'issueNotFound'].includes(error.code)
      || error instanceof WorkspaceError && error.code === 'workspaceAccessDenied') return json({ error: 'drive_not_found' }, 404)
    if (params.organizationId && operation === 'restore' && error instanceof DriveError && error.code === 'drive_version_conflict') {
      return json({ ...driveErrorBody(error), volumeId: params.volumeId }, error.status)
    }
    return driveErrorResponse(error, headers)
  }
}
