import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { auth } from '@/lib/api-auth'
import { writeAllowed } from '@/lib/mobile-api'
import { TASK_FILE_MAX_BYTES } from '@/lib/task-attachments/contract'
import { listTaskFiles, readTaskFile, removeTaskFile, saveTaskFile, TaskFileError } from '@/lib/task-attachments/store'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const failure = (error: string, status: number) => Response.json({ error }, { status, headers })
type Context = { params: Promise<{ taskId: string }> }

async function attachments(request: Request, context: Context) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
  if (!session) return failure('authRequired', 401)
  if (request.method !== 'GET' && !writeAllowed(request)) return failure('originNotAllowed', 403)
  const taskId = z.uuid().safeParse((await context.params).taskId)
  const id = new URL(request.url).searchParams.get('id')
  if (!taskId.success || (id !== null && !z.uuid().safeParse(id).success)) return failure('notFound', 404)
  try {
    const { workspace } = await loadWorkspaceContext(session.tokenWorkspaceId, session.user)
    const actor = { taskId: taskId.data, user: session.user, workspaceId: workspace.id }
    if (request.method === 'GET' && id === null) return Response.json(await listTaskFiles(actor), { headers })
    if (!id) return failure('invalid', 400)
    if (request.method === 'GET') {
      const file = await readTaskFile(actor, id, request.signal)
      return new Response(file.body, { headers: {
        ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
      } })
    }
    if (request.method === 'DELETE') {
      await removeTaskFile(actor, id)
      return new Response(null, { status: 204, headers })
    }
    if (!request.body || !request.headers.get('content-type')?.startsWith('multipart/form-data;')) return failure('invalid', 400)
    let received = 0
    // Bound the entire body before multipart parsing, even without Content-Length.
    const limit = TASK_FILE_MAX_BYTES + 8192
    const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > limit) throw new RangeError()
        controller.enqueue(chunk)
      },
    }))
    const data = await new Response(body, { headers: { 'content-type': request.headers.get('content-type')! } }).formData().catch(() => null)
    if (received > limit) return failure('tooLarge', 413)
    const file = data?.get('file')
    if (!(file instanceof File) || [...data!.keys()].length !== 1 || !file.size) return failure('invalid', 400)
    if (file.size > TASK_FILE_MAX_BYTES) return failure('tooLarge', 413)
    const name = file.name.trim(), size = file.size
    if (!name || name.length > 255 || /[\\/]/.test(name) || [...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
      return failure('invalid', 400)
    const bytes = new Uint8Array(await file.arrayBuffer())
    return Response.json(await saveTaskFile(actor, { id, name, size }, bytes), { headers })
  } catch (error) {
    if (error instanceof ActionFailureError || error instanceof WorkspaceError) return failure('notFound', 404)
    if (error instanceof TaskFileError) return failure(error.code, error.code === 'notFound' ? 404 : 409)
    throw error
  }
}
export const GET = attachments
export const POST = attachments
export const DELETE = attachments
