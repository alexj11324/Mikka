import { auth } from '@/lib/auth'
import { z } from 'zod'
import { setWorkspaceComputerAccess } from '@/lib/cua/policy'

// Settings UI is owned by another change. This authenticated, admin-only API
// is the minimal workspace persistence contract; never consumes model output.
export async function PUT(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' }
  if (request.headers.get('sec-fetch-site') === 'cross-site' || request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Forbidden' }, { status: 403, headers })
  const user = (await auth.api.getSession({ headers: request.headers }))?.user
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'JSON required' }, { status: 415, headers })
  const body = await request.text()
  const parsed = z.object({ workspaceId: z.uuid(), decision: z.enum(['ask', 'allow', 'deny']) }).strict().safeParse(body.length < 2000 ? (() => { try { return JSON.parse(body) } catch { return null } })() : null)
  if (!parsed.success) return Response.json({ error: 'Invalid policy' }, { status: 400, headers })
  try {
    await setWorkspaceComputerAccess(user.id, parsed.data.workspaceId, parsed.data.decision)
    return Response.json({ decision: parsed.data.decision }, { headers })
  } catch { return Response.json({ error: 'Workspace admin access required' }, { status: 403, headers }) }
}
