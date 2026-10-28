import { z } from 'zod'
import { INLINE_UPLOAD_MAX_BYTES, receiveUpload } from '@/lib/captures/store'
import { captureFailure, captureJson, deviceRun } from '@/lib/captures/device'

export const dynamic = 'force-dynamic'

/** `PUT /v1/runs/:runId/captures/:captureId`: the file itself, only where no bucket is configured. */
export async function PUT(request: Request, { params }: { params: Promise<{ runId: string; captureId: string }> }) {
  const { runId, captureId } = await params
  const found = await deviceRun(request, runId)
  if (found instanceof Response) return found
  if (!z.uuid().safeParse(captureId).success) return captureJson({ error: 'Unknown capture.' }, 404)
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > INLINE_UPLOAD_MAX_BYTES) return captureJson({ error: 'Too large.' }, 413)
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length > INLINE_UPLOAD_MAX_BYTES) return captureJson({ error: 'Too large.' }, 413)
  const result = await receiveUpload(found.owner, captureId, bytes)
  return 'error' in result ? captureFailure(result) : new Response(null, { status: 204 })
}
