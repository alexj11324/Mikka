import { reviewPreviewRoute } from '@/lib/coding-workspace/preview/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return reviewPreviewRoute(request, (await context.params).taskId)
}
