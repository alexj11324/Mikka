import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { runChunks } from '@/lib/db/schema'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { addRunMessage, readRun } from '@/lib/agent-runs'
import { ActionFailureError } from '@/lib/action-error'
import { runIsActive, threadItems } from '@/lib/issue-run-conversation'
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
  // readRun checked access; the chunks are read again with their times so people's messages fall in between.
  const chunks = await db.select({ chunk: runChunks.chunk, at: runChunks.createdAt }).from(runChunks)
    .where(eq(runChunks.runId, detail.run.id)).orderBy(asc(runChunks.seq))
  const items = threadItems(
    detail.run.agentId ? chunks : [],
    detail.messages.map(message => ({ id: message.id, text: message.text, author: user.name, mine: true, at: message.createdAt })),
  )
  return json({ thread, active: runIsActive(detail.run.status), summary: detail.run.report && typeof detail.run.report.summary === 'string' ? detail.run.report.summary : null, error: detail.run.error, items })
}

/** `POST /api/mobile/threads/:id` with `{ text }`: a message to the running agent; the daemon delivers it. */
async function handlePOST(request: Request, { params }: Params) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const body = z.object({ text: z.string().trim().min(1).max(10_000) }).safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'messageRequired' }, 400)
  try {
    await addRunMessage(user.id, { runId: (await params).id, text: body.data.text })
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, 400)
    throw error
  }
  return json({ queued: true }, 202)
}

export const GET = withRequestLog('/api/mobile/threads/[id]', handleGET)
export const POST = withRequestLog('/api/mobile/threads/[id]', handlePOST)
