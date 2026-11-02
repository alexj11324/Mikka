import { asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool } from '@/lib/db'
import { agentRuns, runChunks, runMessages } from '@/lib/db/schema'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { readRun } from '@/lib/agent-runs'
import { readRunChain } from '@/lib/run-chain'
import { sendThreadMessage } from '@/lib/thread-continue'
import { ActionFailureError } from '@/lib/action-error'
import { chainChunks, runIsActive, threadItems } from '@/lib/issue-run-conversation'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { mobileThread } from '@/lib/mobile-threads'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** `GET /api/mobile/threads/:id`: one thread as a conversation: agent replies, folded steps, what the person said. */
async function handleGET(request: Request, { params }: Params) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const id = z.uuid().safeParse((await params).id)
  if (!id.success) return json({ error: 'runNotFound' }, 404)
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
  const messages = runIds.length > 1 ? await db.select({ id: runMessages.id, text: runMessages.text, createdAt: runMessages.createdAt }).from(runMessages)
    .where(inArray(runMessages.runId, runIds)).orderBy(asc(runMessages.createdAt)) : detail.messages
  const items = threadItems(
    detail.run.agentId ? chunks : [],
    messages.map(message => ({ id: message.id, text: message.text, author: user.name, mine: true, at: message.createdAt })),
  )
  return json({ thread, active: runIsActive(live), summary: detail.run.report && typeof detail.run.report.summary === 'string' ? detail.run.report.summary : null, error: detail.run.error, items })
}

/** `POST /api/mobile/threads/:id` with `{ text }`: a message to the thread; the daemon delivers it, or an ended thread runs again. */
async function handlePOST(request: Request, { params }: Params) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const body = z.object({ text: z.string().trim().min(1).max(10_000) }).safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'messageRequired' }, 400)
  try {
    // A working thread gets it as a message; an ended one runs again in the same thread (R-81).
    await sendThreadMessage(user.id, (await params).id, body.data.text)
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, 400)
    throw error
  }
  return json({ queued: true }, 202)
}

export const GET = withRequestLog('/api/mobile/threads/[id]', handleGET)
export const POST = withRequestLog('/api/mobile/threads/[id]', handlePOST)
