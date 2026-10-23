import { auth } from '@/lib/auth'
import { computerRequestStore } from '@/lib/cua/store'
import { desktopConfig, desktopFingerprint } from '@/lib/cua/operation'
import { workspaceComputerAccess } from '@/lib/cua/policy'
import { z } from 'zod'

const headers = { 'Cache-Control': 'private, no-store' }
async function owner(request: Request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return null
  if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) return null
  return (await auth.api.getSession({ headers: request.headers }))?.user.id ?? null
}
export async function GET(request: Request) {
  const userId = await owner(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  const parsed = z.uuid().safeParse(new URL(request.url).searchParams.get('sessionId'))
  if (!parsed.success) return Response.json({ error: 'Invalid session' }, { status: 400, headers })
  const config = desktopConfig()
  if (!config) return Response.json({ desktop: null, requests: [] }, { headers })
  try {
    if (await workspaceComputerAccess(userId, config) === 'deny') return Response.json({ desktop: null, requests: [] }, { headers })
  } catch { return Response.json({ error: 'Workspace access unavailable' }, { status: 403, headers }) }
  const requests = await computerRequestStore.pending(userId, parsed.data)
  return Response.json({ desktop: config.url, requests: requests.filter(row => row.workspaceId === config.workspaceId && row.target === desktopFingerprint(config)).map(({ id, operation, expiresAt }) => ({ id, operation, expiresAt })) }, { headers })
}
export async function POST(request: Request) {
  const userId = await owner(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'JSON required' }, { status: 415, headers })
  const body = await request.text()
  if (body.length > 2000) return Response.json({ error: 'Request too large' }, { status: 413, headers })
  const parsed = z.object({ id: z.uuid(), sessionId: z.uuid(), approve: z.boolean() }).strict().safeParse((() => { try { return JSON.parse(body) } catch { return null } })())
  if (!parsed.success) return Response.json({ error: 'Invalid decision' }, { status: 400, headers })
  const config = desktopConfig()
  if (!config) return Response.json({ error: 'Desktop unavailable' }, { status: 503, headers })
  try {
    const row = parsed.data.approve
      ? await computerRequestStore.approve(parsed.data.id, userId, parsed.data.sessionId, desktopFingerprint(config), new Date())
      : await computerRequestStore.consume(parsed.data.id, userId, parsed.data.sessionId, desktopFingerprint(config), new Date(), 'denied')
    if (!row) throw new Error('Not pending')
    return Response.json({ status: parsed.data.approve ? 'approved' : 'denied' }, { headers })
  } catch { return Response.json({ error: 'Operation expired, changed, consumed, or failed. No automatic retry.' }, { status: 409, headers }) }
}
