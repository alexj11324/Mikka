import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { issueForUser } from '@/lib/issue-access'
import { requireTaskWorkspace } from '@/lib/task-workspace'
import { readThreadMode, setThreadMode, threadModeTarget, ThreadModeConflict } from '@/lib/thread-mode/store'
import { readThreadModeSupport } from '@/lib/thread-mode/support'
import { threadModeTransitionSchema } from '@mikka/protocol/thread-mode'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'private, no-store' }

/** One run names the thread; the task/tenant it belongs to is derived here. */
async function target(userId: string, runId: string) {
  const run = await threadModeTarget(pool, userId, runId)
  if (!run || !await issueForUser(userId, run.issueId)) return null
  return run
}

/** The thread's current mode and the version a transition must echo. */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers: noStore })
  try {
    const runId = z.uuid().parse((await params).runId)
    const found = await target(session.user.id, runId)
    if (!found) return NextResponse.json({ error: 'notFound' }, { status: 404, headers: noStore })
    const current = await readThreadMode(pool, session.user.id, found.issueId)
    // An unfinished run keeps the mode it froze; the picker must show that
    // from the first read, not only after a refused transition. Support is
    // the same judgment claim applies, before the run starts.
    const { locked, support } = await readThreadModeSupport(pool, session.user.id, runId)
    return NextResponse.json({ mode: current.mode, version: current.version, frozenMode: found.frozenMode, locked, support }, { headers: noStore })
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: 'invalidRequest' }, { status: 400, headers: noStore })
    return NextResponse.json({ error: 'threadModeUnavailable' }, { status: 503, headers: noStore })
  }
}

/** Explicit transition. An active run keeps the mode it froze: the answer is
 * 409 threadModeLocked until it ends, never a silent switch under it. */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => NextResponse.json(body, { status, headers: noStore })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return respond({ error: 'authRequired' }, 401)
  if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'invalidOrigin' }, 403)
  try {
    const runId = z.uuid().parse((await params).runId)
    const input = threadModeTransitionSchema.parse(await request.json())
    const found = await target(session.user.id, runId)
    if (!found) return respond({ error: 'notFound' }, 404)
    // A lost workspace membership makes the thread unavailable, not writable.
    try { await requireTaskWorkspace(session.user.id, found.workspaceId) }
    catch { return respond({ error: 'notFound' }, 404) }
    const state = await setThreadMode(pool, {
      userId: session.user.id, issueId: found.issueId, workspaceId: found.workspaceId,
      mode: input.mode, expectedVersion: input.expectedVersion, actorName: session.user.name,
    })
    return respond(state, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'invalidRequest' }, 400)
    if (error instanceof ThreadModeConflict) return respond({ error: error.reason }, 409)
    return respond({ error: 'threadModeUnavailable' }, 503)
  }
}
