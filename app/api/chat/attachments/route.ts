import { z } from 'zod'
import {
  CHAT_FILE_CHUNK_BYTES,
  CHAT_FILE_MAX_BYTES,
  chatFileScopeSchema,
} from '@mikka/protocol/chat-attachments'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { writeAllowed } from '@/lib/mobile-api'
import {
  authorizeFileScope,
  beginChatFile,
  completeChatFile,
  uploadChatFilePart,
} from '@/lib/chat-attachments/store'
import { ChatFileError } from '@/lib/chat-attachments/extract'

export const dynamic = 'force-dynamic'
export const maxDuration = 120
const init = z
  .object({
    operation: z.literal('init'),
    scope: chatFileScopeSchema,
    name: z.string().max(255),
    size: z.number().int().positive(),
    mediaType: z.string().max(100),
  })
  .strict()
const complete = z.object({ operation: z.literal('complete'), id: z.uuid() }).strict()
const headers = { 'Cache-Control': 'private, no-store' }
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  if (!writeAllowed(request)) return Response.json({ error: 'originNotAllowed' }, { status: 403, headers })
  try {
    if (request.headers.get('content-type')?.startsWith('application/octet-stream')) {
      const query = new URL(request.url).searchParams
      const id = z.uuid().parse(query.get('id'))
      const part = query.has('part') ? z.coerce.number().int().min(0).max(8).parse(query.get('part')) : null
      const reader = request.body?.getReader()
      if (!reader) throw new ChatFileError('unreadable')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.length
          if (size > (part === null ? CHAT_FILE_MAX_BYTES : CHAT_FILE_CHUNK_BYTES)) {
            await reader.cancel()
            throw new ChatFileError('tooLarge')
          }
          chunks.push(next.value)
        }
      } finally {
        reader.releaseLock()
      }
      return Response.json(
        await (part === null
          ? completeChatFile(session.user.id, id, Buffer.concat(chunks), session.tokenWorkspaceId)
          : uploadChatFilePart(session.user.id, id, part, Buffer.concat(chunks), session.tokenWorkspaceId)),
        { headers },
      )
    }
    const body = await request.text()
    if (body.length > 4096) throw new ChatFileError('unreadable')
    const data = z.discriminatedUnion('operation', [init, complete]).parse(JSON.parse(body))
    if (data.operation === 'complete')
      return Response.json(
        await completeChatFile(session.user.id, data.id, undefined, session.tokenWorkspaceId),
        { headers },
      )
    const workspace = await authorizeFileScope(session.user.id, data.scope)
    if (!apiWorkspaceAllowed(session, workspace)) throw new ChatFileError('notFound')
    return Response.json(await beginChatFile(session.user.id, data.scope, data), { headers })
  } catch (error) {
    const code =
      error instanceof ChatFileError
        ? error.code
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 'unreadable'
          : 'unavailable'
    return Response.json(
      { error: code },
      { status: code === 'notFound' ? 404 : code === 'tooLarge' ? 413 : code === 'unavailable' ? 503 : 400, headers },
    )
  }
}
