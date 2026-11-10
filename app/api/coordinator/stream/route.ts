import { and, eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { getRun } from 'workflow/api'
import { auth } from '@/lib/api-auth'
import { db, pool } from '@/lib/db'
import { awaitTurnHolder, TURN_START_WAIT_MS } from '@/lib/coordinator/turn-holder'
import { coordinatorSessions } from '@/lib/db/schema'
import { coordinatorLeaseActive } from '@/lib/coordinator/lease'
import { coordinatorTextStream, COORDINATOR_STREAM_PROJECTION_VERSION } from '@/lib/coordinator/stream-response'
import type { CoordinatorWorkflowStreamPart } from '@/lib/coordinator/stream'
import { credentialChatFingerprints } from '@/lib/credentials/chat-guard'
import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { requestBotChat } from '@/lib/resource-access/request-chat'
import { ActionFailureError } from '@/lib/action-error'
import { botChatExecutionVisible } from '@/lib/collaboration/bot-chat-provenance'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** The turn about to take the chat with the person's message, woken by takeInbox's NOTIFY (lib/coordinator/turn-holder.ts). */
async function waitForTurn(access: Awaited<ReturnType<typeof requestBotChat>>, authorize: () => Promise<void>) {
  const { ownerId: userId, id: botId } = access
  const [{ COORDINATOR_LEASE_CHANNEL, nextNotification, openListener }, { hasPendingEvents, chatView }] = await Promise.all([import('@/lib/db/listen'), import('@/lib/coordinator/store')])
  return awaitTurnHolder(botId, Date.now() + TURN_START_WAIT_MS, {
    read: async () => {
      await authorize()
      const [row] = await db.select({ leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil }).from(coordinatorSessions)
        .where(and(eq(coordinatorSessions.userId, userId), eq(coordinatorSessions.botId, botId))).limit(1)
      if (coordinatorLeaseActive(row)) return { holder: row!.leaseHolder, waiting: true }
      return { holder: null, waiting: access.viewerId === userId ? await hasPendingEvents(userId, botId)
        : (await chatView(userId, 1, botId, {}, access.reader)).working }
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
  const access = await requestBotChat(session.user, bot.data)
  const botId = access.id
  const authorize = async () => {
    const fresh = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
    if (!fresh || fresh.user.id !== session.user.id || fresh.session.id !== session.session.id) throw new ActionFailureError('authRequired')
    const current = await requestBotChat(fresh.user, botId)
    if (current.ownerId !== access.ownerId || current.workspaceId !== access.workspaceId) throw new ActionFailureError('botNotFound')
  }
  const [chat] = await db.select({ leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil }).from(coordinatorSessions)
    .where(and(eq(coordinatorSessions.userId, access.ownerId), eq(coordinatorSessions.botId, botId))).limit(1)
  // The request's run id is only a version check. The authenticated chat supplies authority.
  const expected = params.get('runId')
  let runId = coordinatorLeaseActive(chat) ? chat?.leaseHolder : null
  // Opened at send (`wait=1`): the message is in the inbox and its turn starts in a moment. Waiting here for it, woken
  // by the turn taking the chat, shows its first words as they come instead of after the chat's next read.
  if (!runId && !expected && params.get('wait') === '1') runId = await waitForTurn(access, authorize)
  if (!runId?.startsWith('wrun_') || expected && expected !== runId) return new Response(null, { status: 204 })
  const executionKey = runId
  const authorizeExecution = async () => {
    await authorize()
    if (access.viewerId !== access.ownerId && !await botChatExecutionVisible(pool, { ownerId: access.ownerId, botId, executionKey })) throw new ActionFailureError('botNotFound')
  }
  await authorizeExecution()
  const fingerprints = await credentialChatFingerprints(access.ownerId)
  const streamKey = createHash('sha256').update(JSON.stringify([access.viewerId, access.workspaceId, runId, fingerprints, COORDINATOR_STREAM_PROJECTION_VERSION])).digest('hex')
  const offset = z.coerce.number().int().min(0).max(1_000_000).safeParse(params.get('after') ?? 0)
  if (!offset.success) return Response.json({ error: 'validationGeneric' }, { status: 400 })
  // A changed masking policy changes chunk boundaries: replay safely instead of skipping under a stale cursor.
  const after = request.headers.get('x-mikka-stream-key') === streamKey ? offset.data : 0
  const run = getRun<unknown>(runId)
  const projection = coordinatorTextStream(access.ownerId, fingerprints, {
    onTiming: timing => console.info(JSON.stringify({ msg: 'coordinator_stream_projection_timing', ...timing })),
  })
  const reader = run.getReadable<CoordinatorWorkflowStreamPart>().pipeThrough(projection).getReader()
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
          // A durable stream never keeps a revoked Session/PAT, stale ACL or
          // private source alive. Check after the awaited chunk, before bytes.
          await authorizeExecution()
          sequence++
          if (sequence <= after) continue
          controller.enqueue(encoder.encode(JSON.stringify({ ...next.value, sequence }) + '\n'))
          return
        }
      } catch {
        projection.reportTerminal(2)
        await reader.cancel('access-or-stream-ended').catch(() => undefined)
        if (!cancelled) {
          controller.enqueue(encoder.encode('{"type":"error"}\n'))
          controller.close()
        }
      }
    },
    async cancel(reason) { cancelled = true; projection.reportTerminal(4); await reader.cancel(reason) },
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

export const GET = withRequestLog('/api/coordinator/stream', async request => {
  try { return await handleGET(request) } catch (error) {
    if (error instanceof ActionFailureError) return Response.json({ error: error.code }, { status: error.code === 'authRequired' ? 401 : 404 })
    throw error
  }
})
