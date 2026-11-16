import { z } from 'zod'
import { auth } from '@/lib/auth'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'

const headers = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return new Response(null, { status: 401, headers })
  const { deviceId } = await params
  const after = new URL(request.url).searchParams.getAll('after')
  if (!z.uuid().safeParse(deviceId).success || after.length > 1 || after.some(id => !z.uuid().safeParse(id).success)) {
    return new Response(null, { status: 400, headers })
  }
  const reader = { id: session.user.id, [enterprisePrincipal]: { kind: 'session' as const, sessionId: session.session.id } }
  const workspaceId = await effectiveRequestWorkspace(reader)
  if (!workspaceId) return new Response(null, { status: 404, headers })
  const [{ activeThreadsOnOwnedDevice }, { pool }] = await Promise.all([import('@/lib/conversation-directory'), import('@/lib/db')])
  const page = await activeThreadsOnOwnedDevice(pool, reader, workspaceId, deviceId, after[0])
  return page ? Response.json(page, { headers }) : new Response(null, { status: 404, headers })
}
