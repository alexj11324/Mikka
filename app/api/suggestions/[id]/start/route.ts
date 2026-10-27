import { after, NextResponse } from 'next/server'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { getSession } from '@/lib/session'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { startSuggestion } from '@/lib/suggestions/execution'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }

/** The person's click is the authorization to hand this suggestion to the Coordinator. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = (await getSession())?.user
  if (!user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  if (request.headers.get('origin') !== new URL(request.url).origin) return NextResponse.json({ error: 'originNotAllowed' }, { status: 403, headers })
  const { id } = await params
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: 'invalidSuggestion' }, { status: 400, headers })
  const started = await startSuggestion(pool, user.id, id)
  if (!started) return NextResponse.json({ error: 'suggestionNotFound' }, { status: 404, headers })
  if (started.state === 'running') after(() => wakeCoordinator(user.id))
  return NextResponse.json({ suggestionId: started.suggestionId, state: started.state }, { status: started.state === 'running' ? 202 : 200, headers })
}
