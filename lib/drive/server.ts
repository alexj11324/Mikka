import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { writeAllowed } from '@/lib/mobile-api'
import { ActionFailureError } from '@/lib/action-error'
import { WorkspaceError } from '@/lib/workspace-error'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { workspaceListChanged } from '@/lib/live/lists'
import { DRIVE_MAX_CHANGES, DRIVE_MAX_FILE_BYTES, isDrivePath, isVolumeId, isVolumeVersionId } from './contract'
import { driveBytes, driveSha256, readDriveBlobObject, recordDriveBlob, storeDriveBlob } from './blobs'
import { applyDriveWrite, DriveError, readDriveHistory, readDriveVersion, restoreDriveVersion } from './store'
import { createDriveVolume, listDriveVolumes, readDriveVolume } from './volumes'
import { driveErrorResponse } from './http'

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const mutationId = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)
const versionId = z.string().refine(isVolumeVersionId)
const write = z.object({ expectedDigest: digest, mutationId, changes: z.array(z.discriminatedUnion('op', [
  z.object({ op: z.literal('put'), path: z.string().refine(isDrivePath), mode: z.union([z.literal(0o644), z.literal(0o755)]), sha256: digest, sizeBytes: z.number().int().min(0).max(DRIVE_MAX_FILE_BYTES) }).strict(),
  z.object({ op: z.literal('delete'), path: z.string().refine(isDrivePath) }).strict(),
])).min(1).max(DRIVE_MAX_CHANGES) }).strict()
const restore = z.object({ versionId, expectedDigest: digest, mutationId }).strict()
type Operation = 'volumes' | 'volume' | 'write' | 'upload' | 'file' | 'history' | 'version' | 'restore'
type Params = { volumeId?: string; versionId?: string }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers })

async function bytes(request: Request, limit: number) {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new DriveError('drive_limit_exceeded', 413)
      }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  return driveBytes(Buffer.concat(chunks, size))
}

async function body(request: Request) {
  return JSON.parse(new TextDecoder().decode(await bytes(request, 16 * 1024 * 1024))) as unknown
}

/** First HTTP surface over the existing volume, CAS and object-store implementation. */
export async function driveResponse(request: Request, operation: Operation, params: Params = {}): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return json({ error: 'authRequired' }, 401)
  if (request.method !== 'GET' && !writeAllowed(request)) return json({ error: 'originNotAllowed' }, 403)
  try {
    const search = new URL(request.url).searchParams
    const workspaceId = z.uuid().parse(search.get('workspaceId'))
    let changed = false
    const response = await withTaskWorkspace(session.user, workspaceId, async () => {
      const actor = { ownerId: session.user.id, authorName: session.user.name }
      if (operation === 'volumes') {
        if (request.method === 'POST') {
          const input = z.object({ name: z.string().trim().min(1).max(200) }).strict().parse(await body(request))
          const volume = await createDriveVolume(pool, actor, { ...input, workspaceId, driveScope: 'user', scopeId: actor.ownerId }, text => createHash('sha256').update(text).digest('hex'))
          changed = true
          return json({ volume }, 201)
        }
        const limit = z.coerce.number().int().min(1).max(100).parse(search.get('limit') ?? '50')
        const before = search.has('before') ? z.string().refine(isVolumeId).parse(search.get('before')) : null
        const result = await listDriveVolumes(pool, actor, { driveScope: 'user', scopeId: actor.ownerId, workspaceId }, { limit: limit + 1, beforeId: before ?? undefined })
        const volumes = result.slice(0, limit)
        return json({ volumes, nextCursor: result.length > limit ? volumes.at(-1)!.id : null })
      }
      const volume = await readDriveVolume(pool, { ownerId: actor.ownerId, workspaceId }, params.volumeId)
      if (operation === 'volume') {
        // Read an immutable manifest named by the head receipt, so a concurrent
        // write cannot mix an old digest with a newer mutable entry tree.
        const version = await readDriveVersion(pool, actor, volume.id, volume.headVersionId)
        return json({ volume, head: { headVersionId: version.id, headDigest: version.digest, entries: version.manifest } })
      }
      if (operation === 'history') {
        const limit = z.coerce.number().int().min(1).max(100).parse(search.get('limit') ?? '50')
        const beforeId = search.has('before') ? versionId.parse(search.get('before')) : undefined
        const versions = await readDriveHistory(pool, actor, volume.id, { limit: limit + 1, beforeId })
        const page = versions.slice(0, limit)
        return json({ versions: page, nextCursor: versions.length > limit ? page.at(-1)!.id : null })
      }
      if (operation === 'version') return json({ version: await readDriveVersion(pool, actor, volume.id, versionId.parse(params.versionId)) })
      if (operation === 'write') {
        const input = write.parse(await body(request))
        const digests = [...new Set(input.changes.flatMap(change => change.op === 'put' ? [change.sha256] : []))]
        if (digests.length) {
          const admitted = await pool.query<{ sha256: string }>(`SELECT sha256 FROM drive_blob_admissions
            WHERE "ownerId"=$1 AND "workspaceId"=$2 AND sha256=ANY($3::text[])`, [actor.ownerId, workspaceId, digests])
          if (admitted.rows.length !== digests.length) throw new DriveError('drive_blob_unknown', 422)
        }
        const result = await applyDriveWrite(pool, { ownerId: actor.ownerId, volumeId: volume.id, driveScope: 'user' }, actor, input)
        changed = !result.replayed
        return json(result)
      }
      if (operation === 'restore') {
        const result = await restoreDriveVersion(pool, { ownerId: actor.ownerId, volumeId: volume.id }, actor, restore.parse(await body(request)))
        changed = !result.replayed
        return json(result)
      }
      if (operation === 'upload') {
        const content = await bytes(request, DRIVE_MAX_FILE_BYTES)
        const blob = await storeDriveBlob(actor.ownerId, content)
        await recordDriveBlob(pool, blob, content)
        await pool.query(`INSERT INTO drive_blob_admissions("ownerId",sha256,"workspaceId") VALUES($1,$2,$3)
          ON CONFLICT("ownerId",sha256,"workspaceId") DO NOTHING`, [actor.ownerId, blob.sha256, workspaceId])
        return json({ sha256: blob.sha256, sizeBytes: blob.sizeBytes }, 201)
      }
      const path = z.string().refine(isDrivePath).parse(search.get('path'))
      const selected = await readDriveVersion(pool, actor, volume.id, search.has('versionId') ? versionId.parse(search.get('versionId')) : volume.headVersionId)
      const entry = selected.manifest.find(item => item.path === path)
      if (!entry) throw new DriveError('drive_not_found', 404)
      const { rows: [blob] } = await pool.query<{ inlineContent: Buffer | null; sizeBytes: number }>(
        `SELECT "inlineContent","sizeBytes" FROM drive_blobs WHERE "ownerId"=$1 AND sha256=$2`, [actor.ownerId, entry.sha256])
      if (!blob || blob.sizeBytes !== entry.sizeBytes) throw new DriveError('drive_not_found', 404)
      if (blob.inlineContent && driveSha256(driveBytes(blob.inlineContent)) !== entry.sha256) throw new DriveError('drive_blob_size_mismatch', 422)
      const content = blob.inlineContent ? driveBytes(blob.inlineContent) : await readDriveBlobObject(actor.ownerId, entry.sha256, request.signal)
      return new Response(content, { headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(entry.sizeBytes),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').at(-1)!)}` } })
    })
    // Both the file mutation and its membership lease have finished. The
    // existing invalidation path resolves recipients afresh and carries no content.
    if (changed) await workspaceListChanged(pool, workspaceId, ['workspace_settings'])
    return response
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: 'drive_write_invalid' }, 400)
    if (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied' || error instanceof WorkspaceError && error.code === 'workspaceAccessDenied') return json({ error: 'drive_not_found' }, 404)
    return driveErrorResponse(error, headers)
  }
}
