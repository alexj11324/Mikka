import { withDeviceRoute } from '@/lib/device-route'
import { z } from 'zod'
import { INLINE_UPLOAD_MAX_BYTES, receiveUpload, resumeUpload } from '@/lib/captures/store'
import { captureFailure, captureJson, deviceRun } from '@/lib/captures/device'


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
  // Read into one buffer of the fixed limit: a missing or wrong content-length
  // must not let the body buffer past it, and an attacker-chosen chunk
  // granularity (millions of one-byte reads) must not grow a parts array far
  // past the byte limit. The shape is lib/coding-workspace/http.ts's reader.
  const reader = request.body?.getReader()
  if (!reader) return captureJson({ error: 'Unreadable body.' }, 400)
  const body = Buffer.allocUnsafe(INLINE_UPLOAD_MAX_BYTES)
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.byteLength > INLINE_UPLOAD_MAX_BYTES) { await reader.cancel(); return captureJson({ error: 'Too large.' }, 413) }
      body.set(value, size)
      size += value.byteLength
    }
  } finally { reader.releaseLock() }
  const result = await receiveUpload(found.owner, captureId, body.subarray(0, size))
  return 'error' in result ? captureFailure(result) : new Response(null, { status: 204 })
}

export const POST = withDeviceRoute(handlePOST)
export const PUT = withDeviceRoute(handlePUT)
