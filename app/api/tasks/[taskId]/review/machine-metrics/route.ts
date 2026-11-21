import { z } from 'zod'
import { computerGone, readComputerMetrics } from '@/lib/computer/e2b-provider'
import { ReviewAuthorityError, taskReviewAuthority } from '@/lib/coding-workspace/review-authority'
import { E2BKeyError } from '@/lib/secrets/flag'

export const maxDuration = 30

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
const bytes = z.int().nonnegative()
const sample = z.object({
  timestamp: z.date(), cpuCount: z.number().positive(), cpuUsedPct: z.number().nonnegative(),
  memUsed: bytes, memTotal: bytes, memCache: bytes, diskUsed: bytes, diskTotal: bytes,
})

/** Return a recent sample of the owner's current Run without connecting to or waking its VM. */
export async function GET(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  try {
    const scope = await taskReviewAuthority(request, taskId)
    if (new URL(request.url).search) return json({ error: 'invalid_request' }, 400)
    if (scope.machineKind !== 'cloud' || !scope.sandboxId || scope.sponsoredPlacement)
      return json({ error: 'machine_metrics_unsupported' }, 404)
    const end = new Date()
    const start = new Date(Math.max(end.getTime() - 5 * 60_000, scope.runStartedAt ? Date.parse(scope.runStartedAt) : end.getTime()))
    let latest: z.infer<typeof sample> | null = null
    if (start < end) {
      const samples = await readComputerMetrics(scope.ownerId, scope.sandboxId, start, end, request.signal)
      for (const row of samples) {
        const current = sample.parse(row)
        if (current.timestamp >= start && current.timestamp <= end && (!latest || current.timestamp > latest.timestamp))
          latest = current
      }
    }
    await taskReviewAuthority(request, taskId, { workspaceId: scope.workspaceId, runId: scope.runId, bindingId: scope.bindingId })
    return json({ runId: scope.runId, sample: latest })
  } catch (error) {
    if (error instanceof ReviewAuthorityError) return json({ error: error.code }, error.status)
    if (computerGone(error)) return json({ error: 'review_machine_gone' }, 409)
    if (error instanceof E2BKeyError) return json({ error: error.code }, 503)
    return json({ error: 'machine_metrics_unavailable' }, 503)
  }
}
