import { screenCaptureRequest } from '@mikka/protocol/capture'
import { screenCaptures } from '@/lib/captures/screen'
import { maskForWorkspace } from '@/lib/secrets/runtime'
import { captureFailure, captureJson, deviceRun } from '@/lib/captures/device'

export const dynamic = 'force-dynamic'
// A recording's file comes off the machine on stop.
export const maxDuration = 120

/**
 * `POST /v1/runs/:runId/screen`: the cloud computer's capture tools, relayed
 * by the cloud worker for the thread it runs. Only a worker scoped to the
 * run's workspace may call it; the desktop is the one the run is bound to.
 */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const found = await deviceRun(request, (await params).runId)
  if (found instanceof Response) return found
  if (!found.caller.scopeWorkspaceId) return captureJson({ error: 'Cloud computer worker required.' }, 403)
  const parsed = screenCaptureRequest.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return captureJson({ error: 'Invalid request.' }, 400)
  const caller = { userId: found.owner.userId, workspaceId: found.caller.scopeWorkspaceId, deviceId: found.deviceId, tokenId: found.caller.tokenId }
  // 4e2 item 4: capture titles and step labels come from the agent; the pixels themselves cannot be masked.
  const input = 'title' in parsed.data && typeof parsed.data.title === 'string' ? { ...parsed.data, title: await maskForWorkspace(caller.workspaceId, parsed.data.title) }
    : parsed.data.action === 'step' ? { ...parsed.data, label: await maskForWorkspace(caller.workspaceId, parsed.data.label) } : parsed.data
  if (input.action === 'step')
    return captureJson({ action: input.action, recorded: await screenCaptures.step(caller, found.owner.runId, input.label, input.source) })
  if (input.action === 'screenshot') {
    const result = await screenCaptures.screenshot(caller, found.owner.runId, input.title, request.signal)
    return 'error' in result ? captureFailure(result) : captureJson({ action: input.action, capture: result })
  }
  if (input.action === 'start_recording') {
    const result = await screenCaptures.startRecording(caller, found.owner.runId, input.title, input.maxSeconds, request.signal)
    return 'error' in result ? captureFailure(result) : captureJson({ action: input.action, ...result })
  }
  const result = await screenCaptures.stopRecording(caller, found.owner.runId)
  return 'error' in result ? captureFailure(result) : captureJson({ action: input.action, capture: result })
}
