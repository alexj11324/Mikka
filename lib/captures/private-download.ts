import 'server-only'
import type { Pool } from 'pg'
import { CAPTURE_EXTENSIONS, type CaptureContentType, type CaptureSource } from '@mikka/protocol/capture'
import { pool } from '../db'
import { presignArtifactGet } from '../artifacts/storage'
import { captureFileResponse } from './serve'

interface CaptureDownload {
  id: string; kind: 'image' | 'video'; contentType: CaptureContentType; title: string; source: CaptureSource
  durationMs: number | null; size: number; createdAt: Date | string; storageKey: string | null; inlineContent: Buffer | null
}

/** The caller first authorizes the Factory task. Object-backed originals use
 * the existing short-lived private download mechanism, so videos can seek and
 * exceed a function's response-body limit without being made public. */
export function createCaptureDownloads(database: Pick<Pool,'query'>, sign: typeof presignArtifactGet = presignArtifactGet) {
  return async (request: Request, userId: string, captureId: string): Promise<Response | null> => {
    const { rows: [row] } = await database.query<CaptureDownload>(`SELECT c.id,c.kind,c."contentType",c.title,c.source,c."durationMs",c.size,c."createdAt",c."storageKey",c."inlineContent"
      FROM run_captures c JOIN agent_runs r ON r.id=c."runId" AND r."userId"=c."userId"
      WHERE c.id=$1 AND c."userId"=$2 AND c.status='ready'`,[captureId,userId])
    if (!row) return null
    const headers = { 'cache-control':'private, no-store', 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff' }
    if (row.inlineContent) return captureFileResponse(request,{ ...row, createdAt:new Date(row.createdAt).toISOString(),bytes:new Uint8Array(row.inlineContent) },headers)
    if (!row.storageKey) return null
    const location = await sign(row.storageKey,row.contentType,`inline; filename="capture.${CAPTURE_EXTENSIONS[row.contentType]}"`,60)
    return new Response(null,{ status:307,headers:{...headers,location} })
  }
}

export const privateCaptureDownload = createCaptureDownloads(pool)
