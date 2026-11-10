import { runActionExecutionResponse } from '@/lib/environments/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(request: Request, { params }: { params: Promise<{ runId: string; executionId: string }> }) {
  const { runId, executionId } = await params
  return runActionExecutionResponse(request, runId, executionId)
}
