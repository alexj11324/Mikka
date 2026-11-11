import { auth } from '@/lib/auth'
import { AgentKitError } from '@/lib/agent-kit/store'
import { agentScope } from '@/lib/agent-kit/service'
import { readAppToolCatalogue } from '@/lib/app-tool-catalogue'

export const dynamic = 'force-dynamic'

const APP = /^[a-z][a-z0-9_]{0,63}$/

/** One Bot's connected app, as the provider actually lists its tools. Read-only; no credential leaves the server. */
export async function GET(request: Request, { params }: { params: Promise<{ botId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const { botId } = await params
  try {
    await agentScope(session.user.id, botId)
  } catch (error) {
    if (error instanceof AgentKitError) return Response.json({ error: error.code }, { status: error.status })
    return Response.json({ error: 'agentScopeUnavailable' }, { status: 503 })
  }
  const app = new URL(request.url).searchParams.get('app') ?? ''
  if (!APP.test(app)) return Response.json({ error: 'invalidApp' }, { status: 400 })
  try {
    return Response.json(await readAppToolCatalogue(session.user.id, app), {
      headers: { 'cache-control': 'private, max-age=60' },
    })
  } catch {
    return Response.json({ error: 'catalogueUnavailable' }, { status: 502 })
  }
}
