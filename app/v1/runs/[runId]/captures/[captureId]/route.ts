import { withDeviceRoute } from '@/lib/device-route'
import { z } from 'zod'
import { INLINE_UPLOAD_MAX_BYTES, receiveUpload, resumeUpload } from '@/lib/captures/store'
import { captureFailure, captureJson, deviceRun } from '@/lib/captures/device'

export const dynamic = 'force-dynamic'

/** Reissue a target for an existing unexpired reservation, including after run completion. */
async function handlePOST(request: Request, { params }: { params: Promise<{ runId: string; captureId: string }> }) {
  const { runId, captureId } = await params
  const found = await deviceRun(request, runId, true)
  if (found instanceof Response) return found
  if (!z.uuid().safeParse(captureId).success) return captureJson({ error: 'Unknown capture.' }, 404)
  const result = await resumeUpload(found.owner, captureId)
  return 'error' in result ? captureFailure(result) : captureJson(result)
}

/** `PUT /v1/runs/:runId/captures/:captureId`: the file itself, only where no bucket is configured. */
async function handlePUT(request: Request, { params }: { params: Promise<{ runId: string; captureId: string }> }) {
  const { runId, captureId } = await params
  const found = await deviceRun(request, runId, true)
  if (found instanceof Response) return found
  if (!z.uuid().safeParse(captureId).success) return captureJson({ error: 'Unknown capture.' }, 404)
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > INLINE_UPLOAD_MAX_BYTES) return captureJson({ error: 'Too large.' }, 413)
  // Read with a hard ceiling: a missing or wrong content-length must not let the
  // body buffer past the inline limit (the shape lib/coding-workspace/http.ts uses).
  const reader = request.body?.getReader()
  if (!reader) return captureJson({ error: 'Unreadable body.' }, 400)
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > INLINE_UPLOAD_MAX_BYTES) { await reader.cancel(); return captureJson({ error: 'Too large.' }, 413) }
      parts.push(value)
    }
  } finally { reader.releaseLock() }
  const result = await receiveUpload(found.owner, captureId, Buffer.concat(parts))
  return 'error' in result ? captureFailure(result) : new Response(null, { status: 204 })
}

export const POST = withDeviceRoute(handlePOST)
export const PUT = withDeviceRoute(handlePUT)
