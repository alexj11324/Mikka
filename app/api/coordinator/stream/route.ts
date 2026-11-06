import { and, eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { openChatBotId } from '@/lib/coordinator/coordinator-bot'
import { z } from 'zod'
import { getRun } from 'workflow/api'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { awaitTurnHolder, TURN_START_WAIT_MS } from '@/lib/coordinator/turn-holder'
import { bots, coordinatorSessions } from '@/lib/db/schema'
import { coordinatorLeaseActive } from '@/lib/coordinator/lease'
import { coordinatorTextStream } from '@/lib/coordinator/stream-response'
import type { CoordinatorWorkflowStreamPart } from '@/lib/coordinator/stream'
import { credentialChatFingerprints } from '@/lib/credentials/chat-guard'
import { noteLogUser, withRequestLog } from '@/lib/request-log'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** The turn about to take the chat with the person's message, woken by takeInbox's NOTIFY (lib/coordinator/turn-holder.ts). */
async function waitForTurn(userId: string, botId: string) {
  const [{ pool }, { COORDINATOR_LEASE_CHANNEL, nextNotification, openListener }, { hasPendingEvents }] = await Promise.all([import('@/lib/db'), import('@/lib/db/listen'), import('@/lib/coordinator/store')])
  return awaitTurnHolder(botId, Date.now() + TURN_START_WAIT_MS, {
    read: async () => {
      const [row] = await db.select({ leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil }).from(coordinatorSessions)
        .where(and(eq(coordinatorSessions.userId, userId), eq(coordinatorSessions.botId, botId))).limit(1)
      if (coordinatorLeaseActive(row)) return { holder: row!.leaseHolder, waiting: true }
      return { holder: null, waiting: await hasPendingEvents(userId, botId) }
    },
    listen: () => openListener(pool, COORDINATOR_LEASE_CHANNEL),
    next: (listener, payload, ms) => nextNotification(listener, payload, ms),
    now: Date.now,
  })
}

async function handleGET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  noteLogUser(session?.user.id)
  if (!session) return Response.json({ error: 'authRequired' }, { status: 401 })
  const params = new URL(request.url).searchParams
  const bot = z.uuid().nullable().safeParse(params.get('botId'))
  if (!bot.success) return Response.json({ error: 'validationGeneric' }, { status: 400 })
  // No bot named: the Coordinator of the workspace this request is in (a token's own workspace).
  const botId = await openChatBotId(session.user, bot.data)
  if (bot.data) {
    const [owned] = await db.select({ workspaceId: bots.workspaceId }).from(bots)
      .where(and(eq(bots.id, bot.data), eq(bots.ownerId, session.user.id))).limit(1)
    if (!owned || !apiWorkspaceAllowed(session, owned.workspaceId)) return Response.json({ error: 'notFound' }, { status: 404 })
  }
  const [chat] = await db.select({ leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil }).from(coordinatorSessions)
    .where(and(eq(coordinatorSessions.userId, session.user.id), eq(coordinatorSessions.botId, botId))).limit(1)
  // The request's run id is only a version check. The authenticated chat supplies authority.
  const expected = params.get('runId')
  let runId = coordinatorLeaseActive(chat) ? chat?.leaseHolder : null
  // Opened at send (`wait=1`): the message is in the inbox and its turn starts in a moment. Waiting here for it, woken
  // by the turn taking the chat, shows its first words as they come instead of after the chat's next read.
  if (!runId && !expected && params.get('wait') === '1') runId = await waitForTurn(session.user.id, botId)
  if (!runId?.startsWith('wrun_') || expected && expected !== runId) return new Response(null, { status: 204 })
  const fingerprints = await credentialChatFingerprints(session.user.id)
  const streamKey = createHash('sha256').update(JSON.stringify([runId, fingerprints])).digest('hex')
  const offset = z.coerce.number().int().min(0).max(1_000_000).safeParse(params.get('after') ?? 0)
  if (!offset.success) return Response.json({ error: 'validationGeneric' }, { status: 400 })
  // A changed masking policy changes chunk boundaries: replay safely instead of skipping under a stale cursor.
  const after = request.headers.get('x-mikka-stream-key') === streamKey ? offset.data : 0
  const run = getRun<unknown>(runId)
  const reader = run.getReadable<CoordinatorWorkflowStreamPart>().pipeThrough(coordinatorTextStream(session.user.id, fingerprints)).getReader()
  const encoder = new TextEncoder()
  let cancelled = false
  let sequence = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const next = await reader.read()
          if (cancelled) return
          if (next.done) { controller.close(); return }
          sequence++
          if (sequence <= after) continue
          controller.enqueue(encoder.encode(JSON.stringify({ ...next.value, sequence }) + '\n'))
          return
        }
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
    'X-Mikka-Stream-Key': streamKey,
    'X-Mikka-Stream-Run': runId,
    'X-Mikka-Stream-Reset': offset.data > 0 && after === 0 ? '1' : '0',
  } })
}

export const GET = withRequestLog('/api/coordinator/stream', handleGET)
