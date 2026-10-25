import { z } from 'zod'
import { auth } from '@/lib/auth'
import { executeScheduleCommand } from '@/lib/schedules/runtime'
import { commandSchema, ScheduleError } from '@/lib/schedules/contract'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const inputSchema = z.object({ workspaceId: z.uuid(), conversation: z.enum(['bot','coordinator']), sessionId: z.string().min(1).max(200), sourceId: z.string().min(1).max(200), command: commandSchema }).strict()
export async function POST(request: Request) {
  if (request.headers.get('cookie')) {
    try { if (new URL(request.headers.get('origin') ?? '').origin !== new URL(request.url).origin) return Response.json({ error: 'originRejected' }, { status: 403 }) }
    catch { return Response.json({ error: 'originRejected' }, { status: 403 }) }
  }
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return Response.json({ error: 'authRequired' }, { status: 401 })
  const text = await request.text()
  if (text.length > 16000) return Response.json({ error: 'scheduleCommandTooLarge' }, { status: 413 })
  const parsed = inputSchema.safeParse((() => { try { return JSON.parse(text) } catch { return null } })())
  if (!parsed.success) return Response.json({ error: 'invalidScheduleCommand' }, { status: 400 })
  const { command, ...context } = parsed.data
  try { return Response.json(await executeScheduleCommand({ ownerId: session.user.id, ...context }, command), { headers: { 'Cache-Control': 'private, no-store' } }) }
  catch (error) {
    if (error instanceof ScheduleError) return Response.json({ error: error.code }, { status: error.status })
    return Response.json({ error: 'scheduleUnavailable' }, { status: 503 })
  }
}
