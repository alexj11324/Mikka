import { reviewPreviewRoute } from '@/lib/coding-workspace/preview/route'

export const maxDuration = 60

export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return reviewPreviewRoute(request, (await context.params).taskId)
}
