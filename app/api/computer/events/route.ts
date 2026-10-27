import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
export const runtime = 'nodejs'
export const maxDuration = 300
/** Owner/workspace-filtered resumable events; never carries CDP targets or tokens. */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return new Response(null, { status: 401 })
  const context = await loadWorkspaceContext(undefined, session.user)
  const previous = request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('after') ?? '0'
  if (!/^\d{1,16}$/.test(previous)) return new Response(null, { status: 400 })
  let cursor = previous
  const encoder = new TextEncoder()
  const stream = new ReadableStream({ async start(controller) {
    const until = Date.now() + 240_000
    try {
      while (!request.signal.aborted && Date.now() < until) {
        const { rows } = await pool.query('SELECT seq,event FROM subagent_events WHERE "ownerId"=$1 AND "workspaceId"=$2 AND seq>$3 ORDER BY seq LIMIT 100', [session.user.id, context.workspace.id, cursor])
        for (const row of rows) { cursor = String(row.seq); controller.enqueue(encoder.encode(`id: ${cursor}\nevent: data-subagent\ndata: ${JSON.stringify(row.event.data)}\n\n`)) }
        if (!rows.length) controller.enqueue(encoder.encode(': keepalive\n\n'))
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    } catch { /* Client disconnect and database failures close the stream. */ }
    finally { try { controller.close() } catch { /* Already cancelled. */ } }
  } })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no' } })
}
