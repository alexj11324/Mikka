import 'server-only'
import { NextResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { ActionFailureError } from '@/lib/action-error'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'

export const botResponse = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })

const notFound = new Set(['botNotFound'])
const forbidden = new Set(['workspaceAccessDenied'])

/**
 * One Bot's HTTP entry (web, iOS, desktop): a session, a same-origin write, the
 * workspace the session may act in (`?workspaceId=`), then the operation. A Bot
 * outside that workspace reads as not found; refusals keep their action code.
 */
export async function botRoute(request: Request, params: Promise<{ botId: string }>,
  work: (scope: { userId: string; workspaceId: string; botId: string }) => Promise<unknown>) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session) return botResponse({ error: 'authRequired' }, 401)
  const { botId } = await params
  if (!z.uuid().safeParse(botId).success) return botResponse({ error: 'botNotFound' }, 404)
  if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) return botResponse({ error: 'invalidOrigin' }, 403)
  const requested = new URL(request.url).searchParams.get('workspaceId') ?? undefined
  if (requested !== undefined && !z.uuid().safeParse(requested).success) return botResponse({ error: 'validationGeneric' }, 400)
  let context: Awaited<ReturnType<typeof loadWorkspaceContext>>
  try {
    context = await loadWorkspaceContext(requested, session.user)
  } catch (error) {
    if (error instanceof WorkspaceError) return botResponse({ error: 'botNotFound' }, 404)
    throw error
  }
  if (!apiWorkspaceAllowed(session, context.workspace.id)) return botResponse({ error: 'botNotFound' }, 404)
  try {
    return botResponse(await work({ userId: session.user.id, workspaceId: context.workspace.id, botId }))
  } catch (error) {
    const code = error instanceof ActionFailureError || error instanceof WorkspaceError ? error.code : error instanceof z.ZodError ? 'validationGeneric' : null
    if (!code) throw error
    return botResponse({ error: code }, notFound.has(code) ? 404 : forbidden.has(code) ? 403 : 400)
  }
}

/** The JSON body, or a validation refusal. */
export async function botBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const body = schema.safeParse(await request.json().catch(() => null))
  if (!body.success) throw new ActionFailureError('validationGeneric')
  return body.data
}
