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
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length > INLINE_UPLOAD_MAX_BYTES) return captureJson({ error: 'Too large.' }, 413)
  const result = await receiveUpload(found.owner, captureId, bytes)
  return 'error' in result ? captureFailure(result) : new Response(null, { status: 204 })
}

export const POST = withDeviceRoute(handlePOST)
export const PUT = withDeviceRoute(handlePUT)
