import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { writeAllowed } from '@/lib/mobile-api'
import {
  chatFileBytes,
  chatFileDownloadUrl,
  readChatFile,
  removeChatFile,
} from '@/lib/chat-attachments/store'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  const parsed = z.uuid().safeParse((await context.params).id)
  if (!parsed.success) return Response.json({ error: 'notFound' }, { status: 404, headers })
  try {
    const file = await readChatFile(session.user, parsed.data)
    if (new URL(request.url).searchParams.has('info'))
      return Response.json(
        { id: file.id, name: file.name, mediaType: file.mediaType, size: file.size },
        { headers },
      )
    const query = new URL(request.url).searchParams
    if (query.has('download-url'))
      return Response.json(
        {
          downloadUrl: chatFileDownloadUrl(file.id, request.url),
        },
        { headers },
      )
    const inline =
      /^(image\/(png|jpeg|webp|gif)|application\/pdf|audio\/)/.test(file.mediaType) &&
      !new URL(request.url).searchParams.has('download')
    const bytes = new Uint8Array(await chatFileBytes(file))
    const current = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
    if (!current || current.user.id !== session.user.id || current.session.id !== session.session.id) throw Error('authRequired')
    await readChatFile(current.user, parsed.data)
    return new Response(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}}), {
      headers: {
        ...headers,
        'Content-Type': file.mediaType,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    })
  } catch {
    return Response.json({ error: 'notFound' }, { status: 404, headers })
  }
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  if (!writeAllowed(request)) return Response.json({ error: 'originNotAllowed' }, { status: 403, headers })
  const parsed = z.uuid().safeParse((await context.params).id)
  if (!parsed.success) return Response.json({ error: 'notFound' }, { status: 404, headers })
  try {
    await removeChatFile(session.user, parsed.data, session.tokenWorkspaceId)
    return Response.json({ removed: true }, { headers })
  } catch {
    return Response.json({ error: 'notFound' }, { status: 404, headers })
  }
}
