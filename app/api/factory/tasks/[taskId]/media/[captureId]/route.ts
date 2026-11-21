import { serveFactoryTaskMedia } from '@/lib/factory/task-media-route'


/** Any ready capture from this task's own runs, not only report references. */
export async function GET(request: Request, context: { params: Promise<{ taskId: string; captureId: string }> }) {
  const { taskId,captureId } = await context.params
  return serveFactoryTaskMedia(request,taskId,captureId)
}
