import { withDeviceRoute } from '@/lib/device-route'
import { z } from 'zod'
import { completeUpload } from '@/lib/captures/store'
import { captureFailure, captureJson, deviceRun } from '@/lib/captures/device'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/runs/:runId/captures/:captureId/complete`: the file has been
 * sent. The server checks it against what was announced before it counts.
 */
async function handlePOST(request: Request, { params }: { params: Promise<{ runId: string; captureId: string }> }) {
  const { runId, captureId } = await params
  const found = await deviceRun(request, runId, true)
  if (found instanceof Response) return found
  if (!z.uuid().safeParse(captureId).success) return captureJson({ error: 'Unknown capture.' }, 404)
  const result = await completeUpload(found.owner, captureId)
  return 'error' in result ? captureFailure(result) : captureJson({ capture: result })
}

export const POST = withDeviceRoute(handlePOST)
