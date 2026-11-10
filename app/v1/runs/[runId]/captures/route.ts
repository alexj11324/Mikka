import { withDeviceRoute } from '@/lib/device-route'
import { captureUploadRequest } from '@mikka/protocol/capture'
import { beginUpload } from '@/lib/captures/store'
import { maskFor } from '@/lib/secrets/runtime'
import { captureFailure, captureJson, deviceRun } from '@/lib/captures/device'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/runs/:runId/captures`: the daemon announces a screenshot or
 * recording a thread saved (`submit_capture`) and learns where to send it.
 */
async function handlePOST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const found = await deviceRun(request, (await params).runId)
  if (found instanceof Response) return found
  const parsed = captureUploadRequest.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return captureJson({ error: 'Invalid capture.' }, 400)
  const scope = { workspaceId: found.caller.scopeWorkspaceId, ownerId: found.owner.userId }
  const input = { ...parsed.data, title: await maskFor(scope, parsed.data.title),
    ...(parsed.data.steps ? { steps: await Promise.all(parsed.data.steps.map(async step => ({ ...step, label: await maskFor(scope, step.label) }))) } : {}) }
  const result = await beginUpload(found.owner, input)
  return 'error' in result ? captureFailure(result) : captureJson(result, 201)
}

export const POST = withDeviceRoute(handlePOST)
