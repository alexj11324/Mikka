import { egressBindingActive } from '@/lib/secrets/egress-binding'
import { executeEgressRequest } from '@/lib/secrets/egress-http'
import { taskSecretEgressResponse } from '@/lib/secrets/egress-route'

export const maxDuration = 30

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  return taskSecretEgressResponse(request, (await params).runId,
    (input, expected, options) => executeEgressRequest(input, expected, { ...options, bindingActive: egressBindingActive }))
}
