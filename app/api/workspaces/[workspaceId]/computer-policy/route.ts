import { z } from 'zod'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace } from '@/lib/workspace-access'
import { ComputerStore } from '@/lib/computer/store'

export const runtime = 'nodejs'
export const maxDuration = 120
const headers = { 'cache-control': 'private, no-store' }
const input = z.object({ permission: z.enum(['ask', 'deny']) }).strict()

async function context(request: Request, workspaceId: string, admin: boolean) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user || !z.uuid().safeParse(workspaceId).success) return null
  try {
    return await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, session.user.id, admin))
  } catch { return null }
}
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1') return Response.json({ enabled: false }, { headers })
  const { workspaceId } = await params
  const member = await context(request, workspaceId, false)
  if (!member) return Response.json({ error: 'Workspace unavailable' }, { status: 403, headers })
  try { return Response.json({ enabled: true, permission: await new ComputerStore(pool).policy(workspaceId), canEdit: member.membership.role === 'admin' }, { headers }) }
  catch { return Response.json({ error: 'Computer policy unavailable' }, { status: 503, headers }) }
}
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1') return Response.json({ error: 'Computer policy unavailable' }, { status: 503, headers })
  if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Invalid origin' }, { status: 403, headers })
  const { workspaceId } = await params
  if (!await context(request, workspaceId, true)) return Response.json({ error: 'Workspace unavailable' }, { status: 403, headers })
  const raw = await request.text()
  if (raw.length > 200) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
  const parsed = input.safeParse((() => { try { return JSON.parse(raw) } catch { return null } })())
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
  try { return Response.json(await new ComputerStore(pool).setPolicy(workspaceId, parsed.data.permission), { headers }) }
  catch { return Response.json({ error: 'Computer policy unavailable' }, { status: 503, headers }) }
}
