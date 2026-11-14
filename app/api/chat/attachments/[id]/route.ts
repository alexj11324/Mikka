import { z } from 'zod'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { ChatFileError } from '@/lib/chat-attachments/extract'
import { writeAllowed } from '@/lib/mobile-api'
import {
  authorizeFileScope,
  chatFileBytes,
  chatFileDownloadUrl,
  fileScope,
  readChatFile,
  removeChatFile,
} from '@/lib/chat-attachments/store'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
function fileErrorResponse(error: unknown) {
  const missing = error instanceof ChatFileError && error.code === 'notFound'
  return Response.json({ error: missing ? 'notFound' : 'unavailable' }, { status: missing ? 404 : 503, headers })
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  const parsed = z.uuid().safeParse((await context.params).id)
  if (!parsed.success) return Response.json({ error: 'notFound' }, { status: 404, headers })
  try {
    const file = await readChatFile(session.user.id, parsed.data)
    if (!apiWorkspaceAllowed(session, await authorizeFileScope(session.user.id, fileScope(file))))
      throw new ChatFileError('notFound')
    if (new URL(request.url).searchParams.has('info'))
      return Response.json(
        { id: file.id, name: file.name, mediaType: file.mediaType, size: file.size },
        { headers },
      )
    const query = new URL(request.url).searchParams
    const downloadUrl = await chatFileDownloadUrl(file, query.has('download') || query.has('download-url'))
    if (query.has('download-url'))
      return Response.json(
        {
          downloadUrl:
            downloadUrl ?? `${new URL(request.url).origin}${new URL(request.url).pathname}?download`,
        },
        { headers },
      )
    if (downloadUrl)
      return new Response(null, { status: 307, headers: { ...headers, Location: downloadUrl } })
    const inline =
      /^(image\/(png|jpeg|webp|gif)|application\/pdf|audio\/)/.test(file.mediaType) &&
      !new URL(request.url).searchParams.has('download')
    return new Response(new Uint8Array(await chatFileBytes(file)), {
      headers: {
        ...headers,
        'Content-Type': file.mediaType,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    })
  } catch (error) {
    return fileErrorResponse(error)
  }
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  if (!writeAllowed(request)) return Response.json({ error: 'originNotAllowed' }, { status: 403, headers })
  const parsed = z.uuid().safeParse((await context.params).id)
  if (!parsed.success) return Response.json({ error: 'notFound' }, { status: 404, headers })
  try {
    await removeChatFile(session.user.id, parsed.data, session.tokenWorkspaceId)
    return Response.json({ removed: true }, { headers })
  } catch (error) {
    return fileErrorResponse(error)
  }
}
