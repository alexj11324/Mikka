import { asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool } from '@/lib/db'
import { agentRuns, runChunks } from '@/lib/db/schema'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { readRun, readRunMessages } from '@/lib/agent-runs'
import { readRunChain } from '@/lib/run-chain'
import { sendThreadMessage } from '@/lib/thread-continue'
import { ActionFailureError } from '@/lib/action-error'
import { chainChunks, runIsActive, runIsWorking, threadItems } from '@/lib/issue-run-conversation'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { mobileThread } from '@/lib/mobile-threads'
import { runOutsideToken } from '@/lib/tokens/scope'
import { threadQuotaView } from '@/lib/run-quota-view'
import { threadLiveReferences } from '@/lib/live/panels'
import { workspacePool } from '@/lib/workspace-db'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** `GET /api/mobile/threads/:id`: one thread as a conversation: agent replies, folded steps, what the person said. */
async function handleGET(request: Request, { params }: Params) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const id = z.uuid().safeParse((await params).id)
  if (!id.success || await runOutsideToken(user, id.data)) return json({ error: 'runNotFound' }, 404)
  const [thread, detail] = await Promise.all([mobileThread(user.id, id.data), readRun(user.id, id.data)])
  if (!thread || !detail) return json({ error: 'runNotFound' }, 404)
  // readRun checked access. The thread is its runs from this one on (R-81: an ended thread runs again in it);
  // the chunks are read with their times so people's messages fall in between.
  const chain = detail.run.agentId ? await readRunChain(pool, user.id, detail.run.id) : null
  const from = chain ? Math.max(0, chain.attempts.findIndex(attempt => attempt.runId === detail.run.id)) : 0
  const runIds = chain ? chain.attempts.slice(from).map(attempt => attempt.runId) : [detail.run.id]
  const live = chain?.attempts.find(attempt => attempt.runId === chain.latestRunId)?.status ?? detail.run.status
  const chunks = chainChunks(await db.select({ runId: runChunks.runId, chunk: runChunks.chunk, at: runChunks.createdAt }).from(runChunks)
    .innerJoin(agentRuns, eq(agentRuns.id, runChunks.runId))
    .where(inArray(runChunks.runId, runIds)).orderBy(asc(agentRuns.createdAt), asc(runChunks.seq)))
  const messages = runIds.length > 1 ? await readRunMessages(user.id, runIds) : detail.messages
  const items = threadItems(
    detail.run.agentId ? chunks : [],
    messages.map(message => ({ id: message.id, text: message.text, author: user.name, mine: true, at: message.createdAt })),
  )
  // A run paused on its subscription's quota: when it resets and whether a key can take over (the web's ThreadQuotaPausedCard).
  const liveRunId = chain?.latestRunId ?? detail.run.id
  const [{ paused }, runs, delivery] = await Promise.all([
    live === 'paused' ? threadQuotaView(user.id, [liveRunId], liveRunId) : { paused: null },
    // Where each run's thread and run keys arrive (the web's thread panel listens to the same).
    threadLiveReferences(pool, workspacePool, runIds, user.id),
    chain ? (await import('@/lib/thread-delivery-queue')).threadDeliveryView(pool, user.id, chain.rootRunId, liveRunId) : undefined,
  ])
  return json({ liveRunId, delivery, issueId: detail.run.issueId, canReply: Boolean(detail.run.agentId), confirmedSubmissionIds: messages.flatMap(message => message.submissionId ? [message.submissionId] : []), live: { runs }, thread, active: runIsActive(live), working: runIsWorking(live), paused, summary: detail.run.report && typeof detail.run.report.summary === 'string' ? detail.run.report.summary : null, error: detail.run.error, items })
}

/** `POST /api/mobile/threads/:id` with `{ text }`: a message to the thread; the daemon delivers it, or an ended thread runs again. */
async function handlePOST(request: Request, { params }: Params) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const body = z.object({ text: z.string().trim().min(1).max(10_000) }).safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'messageRequired' }, 400)
  const id = (await params).id
  if (z.uuid().safeParse(id).success && await runOutsideToken(user, id)) return json({ error: 'runNotFound' }, 404)
  try {
    // A working thread gets it as a message; an ended one runs again in the same thread (R-81).
    await sendThreadMessage(user.id, id, body.data.text)
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, 400)
    throw error
  }
  return json({ queued: true }, 202)
}

export const GET = withRequestLog('/api/mobile/threads/[id]', handleGET)
export const POST = withRequestLog('/api/mobile/threads/[id]', handlePOST)
