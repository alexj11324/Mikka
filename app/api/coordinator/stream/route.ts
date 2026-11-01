import { and, eq } from 'drizzle-orm'
import { chatBotId } from '@/lib/coordinator/coordinator-bot'
import { z } from 'zod'
import { getRun } from 'workflow/api'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { bots, coordinatorSessions } from '@/lib/db/schema'
import { coordinatorLeaseActive } from '@/lib/coordinator/lease'
import { coordinatorTextStream } from '@/lib/coordinator/stream-response'
import type { CoordinatorWorkflowStreamPart } from '@/lib/coordinator/stream'
import { credentialChatFingerprints } from '@/lib/credentials/chat-guard'
import { noteLogUser, withRequestLog } from '@/lib/request-log'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

async function handleGET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  noteLogUser(session?.user.id)
  if (!session) return Response.json({ error: 'authRequired' }, { status: 401 })
  const params = new URL(request.url).searchParams
  const bot = z.uuid().nullable().safeParse(params.get('botId'))
  if (!bot.success) return Response.json({ error: 'validationGeneric' }, { status: 400 })
  // No bot named: the person's Coordinator, whose bot row may live in another workspace than the token's.
  const botId = bot.data ?? await chatBotId(session.user.id, null)
  if (bot.data) {
    const [owned] = await db.select({ workspaceId: bots.workspaceId }).from(bots)
      .where(and(eq(bots.id, bot.data), eq(bots.ownerId, session.user.id))).limit(1)
    if (!owned || !apiWorkspaceAllowed(session, owned.workspaceId)) return Response.json({ error: 'notFound' }, { status: 404 })
  }
  const [chat] = await db.select({ leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil }).from(coordinatorSessions)
    .where(and(eq(coordinatorSessions.userId, session.user.id), eq(coordinatorSessions.botId, botId))).limit(1)
  // The request's run id is only a version check. The authenticated chat supplies authority.
  const expected = params.get('runId')
  const runId = chat?.leaseHolder
  if (!coordinatorLeaseActive(chat) || !runId?.startsWith('wrun_') || expected && expected !== runId) return new Response(null, { status: 204 })
  const fingerprints = await credentialChatFingerprints(session.user.id)
  const run = getRun<unknown>(runId)
  const reader = run.getReadable<CoordinatorWorkflowStreamPart>().pipeThrough(coordinatorTextStream(session.user.id, fingerprints)).getReader()
  const encoder = new TextEncoder()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (cancelled) return
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(JSON.stringify(next.value) + '\n'))
      } catch {
        if (!cancelled) {
          controller.enqueue(encoder.encode('{"type":"error"}\n'))
          controller.close()
        }
      }
    },
    async cancel(reason) { cancelled = true; await reader.cancel(reason) },
  })
  return new Response(body, { headers: {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  } })
}

export const GET = withRequestLog('/api/coordinator/stream', handleGET)
