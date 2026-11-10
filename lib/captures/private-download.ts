import 'server-only'
import type { Pool } from 'pg'
import { CAPTURE_EXTENSIONS, type CaptureContentType, type CaptureSource } from '@mikka/protocol/capture'
import { pool } from '../db'
import { getArtifactObjectRange } from '../artifacts/storage'
import { captureFileResponse } from './serve'

interface CaptureDownload {
  id: string; kind: 'image' | 'video'; contentType: CaptureContentType; title: string; source: CaptureSource
  durationMs: number | null; size: number; createdAt: Date | string; storageKey: string | null; inlineContent: Buffer | null
}

/** The caller authorizes the Factory task; the exact capture's Thread is an
 * independent boundary. Object-backed originals stream without returning a
 * transferable object-storage URL. Repeated seeks repeat authorization. */
export function createCaptureDownloads(database: Pick<Pool,'query'>, read: typeof getArtifactObjectRange = getArtifactObjectRange) {
  return async (request: Request, userId: string, captureId: string): Promise<Response | null> => {
    const { rows: [row] } = await database.query<CaptureDownload>(`SELECT c.id,c.kind,c."contentType",c.title,c.source,c."durationMs",c.size,c."createdAt",c."storageKey",c."inlineContent"
      FROM run_captures c JOIN agent_runs r ON r.id=c."runId" AND r."userId"=c."userId"
      WHERE c.id=$1 AND c.status='ready'
        AND mikka_resource_acl_allowed('account',$2,r."workspaceId",'thread',r.id,'canReadContent')`,[captureId,userId])
    if (!row) return null
    const headers = { 'cache-control':'private, no-store', 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff' }
    if (row.inlineContent) return captureFileResponse(request,{ ...row, createdAt:new Date(row.createdAt).toISOString(),bytes:new Uint8Array(row.inlineContent) },headers)
    if (!row.storageKey) return null
    const object = await read(row.storageKey,request)
    const responseHeaders: Record<string, string> = { ...headers, 'content-type': row.contentType,
      'content-disposition': `inline; filename="capture.${CAPTURE_EXTENSIONS[row.contentType]}"`,
      'content-security-policy': "sandbox; default-src 'none'", 'cross-origin-resource-policy': 'same-origin', 'accept-ranges': 'bytes' }
    if (object.status === 416) {
      await object.body?.cancel()
      return new Response(null,{ status:416,headers:{ ...responseHeaders,'content-range':`bytes */${row.size}` } })
    }
    for (const name of ['content-range','content-length']) {
      const value = object.headers.get(name)
      if (value) responseHeaders[name] = value
    }
    return new Response(object.body,{ status:object.status,headers:responseHeaders })
  }
}

export const privateCaptureDownload = createCaptureDownloads(pool)
