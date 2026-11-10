import { cancelRunActionResponse } from '@/lib/environments/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: Request, { params }: { params: Promise<{ runId: string; executionId: string }> }) {
  const { runId, executionId } = await params
  return cancelRunActionResponse(request, runId, executionId)
}
