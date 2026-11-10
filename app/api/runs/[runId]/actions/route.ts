import { runActionsResponse, requestRunActionResponse } from '@/lib/environments/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  return runActionsResponse(request, (await params).runId)
}

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  return requestRunActionResponse(request, (await params).runId)
}
