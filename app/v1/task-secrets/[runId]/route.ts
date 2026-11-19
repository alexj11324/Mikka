import { taskSecretEgressResponse } from '@/lib/secrets/egress-route'

export const maxDuration = 30

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  return taskSecretEgressResponse(request, (await params).runId)
}
