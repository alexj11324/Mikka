import { z } from 'zod'
import type { SubscriptionService } from './subscription-service'

/**
 * POST handler for one device run's access lease. The token is in the
 * response body only: never logged, never cached, never in a URL.
 */
export function subscriptionNativeLease(deps: {
  authorize(request: Request, deviceId: string): Promise<string | null>
  service(): Pick<SubscriptionService, 'nativeRun' | 'nativeLease'>
}) {
  return async (request: Request, context: { params: Promise<{ deviceId: string; runId: string }> }): Promise<Response> => {
    const headers = { 'cache-control': 'private, no-store' }
    try {
      const { deviceId, runId } = await context.params
      if (!z.uuid().safeParse(deviceId).success || !z.uuid().safeParse(runId).success) return new Response(null, { status: 404, headers })
      const owner = await deps.authorize(request, deviceId)
      if (!owner) return new Response(null, { status: 401, headers })
      const service = deps.service()
      const use = await service.nativeRun(owner, deviceId, runId)
      return Response.json(await service.nativeLease(use, request.signal), { headers })
    } catch {
      return Response.json({ error: 'subscription_unavailable' }, { status: 409, headers })
    }
  }
}
