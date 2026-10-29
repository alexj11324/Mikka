import { after, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { startSuggestion } from '@/lib/cloud-computer/suggestions'
import { ComputerError } from '@/lib/computer/store'
import { wakeCoordinator } from '@/lib/coordinator/wake'
export const runtime = 'nodejs'
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const respond = (value: unknown, status: number) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const id = z.uuid().parse((await params).id)
    const context = await loadWorkspaceContext(undefined, session.user)
    const result = await startSuggestion(pool, { userId: session.user.id, workspaceId: context.workspace.id }, id)
    after(() => wakeCoordinator(session.user.id))
    return respond(result, 202)
  } catch (error) {
    if (error instanceof ComputerError) return respond({ error: error.message }, error.status)
    if (error instanceof z.ZodError) return respond({ error: 'Invalid suggestion' }, 400)
    return respond({ error: 'Task start unavailable' }, 503)
  }
}
