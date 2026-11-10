import { serveFactoryTaskMedia } from '@/lib/factory/task-media-route'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

/** A private real-frame JPEG, generated once for new and historical videos. */
export async function GET(request: Request, context: { params: Promise<{ taskId: string; captureId: string }> }) {
  const { taskId,captureId } = await context.params
  return serveFactoryTaskMedia(request,taskId,captureId,true)
}
