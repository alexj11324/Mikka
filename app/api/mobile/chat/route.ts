import { ChatFileError } from '@/lib/chat-attachments/extract'
import { afterJob } from '@/lib/background'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { CHAT_FIRST_PAGE, chatUpdate, chatView } from '@/lib/coordinator/store'
import { openChatBotId } from '@/lib/coordinator/coordinator-bot'
import { reactionsFor } from '@/lib/reactions'
import { chatFailure } from '@/lib/chat-failure'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'
import { recordPersonalSubmission, SubmissionConflictError } from '@/lib/coordinator-submission'
import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { coordinatorHistory, pollCoordinatorChat, sendCoordinatorMessage } from '@/app/actions/coordinator'
import { ActionFailureError } from '@/lib/action-error'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { MESSAGE_MAX } from '@/lib/message-limits'
import { userImageInputsSchema } from '@/lib/coordinator/user-attachments'

export const dynamic = 'force-dynamic'

const botParam = z.uuid().nullable()

/** Only PATs need an additional bound-workspace fence; browser actions retain their own checks. */
async function tokenBotAllowed(user: { id: string; [tokenWorkspace]?: string }, botId: string | null) {
  if (!botId || !user[tokenWorkspace]) return true
  const [bot] = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, botId), eq(bots.ownerId, user.id), eq(bots.workspaceId, user[tokenWorkspace]!))).limit(1)
  return Boolean(bot)
}

/** Reactions on the chat's stored messages (a message still waiting has no id yet). */
const reactionsOf = (userId: string, items: readonly { id?: string }[]) => reactionsFor(userId, items.flatMap(item => item.id ? [item.id] : []))

const position = z.coerce.number().int().min(0)
/** Where the chat already ends (`ChatView.continuation`): a read from it returns only what came after. */
const continuationParams = z.object({ after: position, cursor: position, prefix: z.string().regex(/^[0-9a-f]{32}$/) })

/** One of three reads, picked by the query: older messages (`through`), what is new since `after`, or the latest page. */
function readKind(params: URLSearchParams) {
  if (params.has('through')) {
    const through = position.safeParse(params.get('through'))
    return through.success ? { kind: 'history' as const, through: through.data } : null
  }
  if (params.has('after')) {
    const continuation = continuationParams.safeParse({ after: params.get('after'), cursor: params.get('cursor'), prefix: params.get('prefix') })
    return continuation.success ? { kind: 'update' as const, continuation: continuation.data } : null
  }
  return { kind: 'latest' as const }
}

/**
 * `GET /api/mobile/chat?bot=<id>`: the chat with the Coordinator (no `bot`) or one of the person's bots, as the web
 * reads it: the latest `CHAT_FIRST_PAGE` messages, `historyBefore` when there are older ones.
 * - `&through=<position>`: the page of older messages up to `position` (scrolling up).
 * - `&after=&cursor=&prefix=` (the last read's `continuation`): what is new since it, with `after`; the app keeps the
 *   messages it has up to `after`. If the chat changed before that point, the latest page as a full read.
 */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const params = new URL(request.url).searchParams
  const bot = botParam.safeParse(params.get('bot'))
  if (!bot.success) return json({ error: 'invalidBot' }, 400)
  const read = readKind(params)
  if (!read) return json({ error: 'invalidWindow' }, 400)
  try {
    if (typeof user[tokenWorkspace] === 'string') {
      if (!await tokenBotAllowed(user, bot.data)) return json({ error: 'botNotFound' }, 404)
      const botId = await openChatBotId(user, bot.data)
      if (read.kind === 'history') return history(user.id, await chatView(user.id, CHAT_FIRST_PAGE, botId, { through: read.through }))
      const enabled = await coordinatorEnabled(user.id, botId)
      const view = await chatUpdate(user.id, botId, read.kind === 'update' ? read.continuation : undefined)
      // The app shows a failed welcome through `failure`; the empty Bot item is no message (nor unread, nor reactable).
      const chat = { ...view, items: view.items.filter(item => !item.welcome) }
      const working = enabled && chat.working
      return json({ ...chat, submissionIds: true, enabled, working, failure: enabled ? chatFailure({ working, error: chat.error, cause: chat.cause, failureDetails: chat.failureDetails, items: chat.items }) : null, reactions: await reactionsOf(user.id, chat.items) })
    }
    if (read.kind === 'history') return history(user.id, await coordinatorHistory(bot.data, read.through, CHAT_FIRST_PAGE))
    const polled = await pollCoordinatorChat(bot.data, undefined, read.kind === 'update' ? read.continuation : undefined)
    // Without a known version the poll always returns the chat itself.
    if ('unchanged' in polled) throw new Error('chatUnchangedWithoutVersion')
    const chat = { ...polled, items: polled.items.filter(item => !item.welcome) }
    return json({ ...chat, submissionIds: true, failure: chat.enabled ? chatFailure(chat) : null, reactions: await reactionsOf(user.id, chat.items) })
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, 404)
    throw error
  }
}

/** An older page: its messages and what they cite, and whether there are older ones still. */
async function history(userId: string, page: Awaited<ReturnType<typeof chatView>>) {
  const items = page.items.filter(item => !item.welcome)
  return json({ items, sources: page.sources, artifacts: page.artifacts, historyBefore: page.historyBefore ?? null, reactions: await reactionsOf(userId, items) })
}

/** `submissionId` identifies one immutable send across mobile retries; older clients may omit it. */
async function handlePOST(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const parsed = z.object({ text: z.string().trim().max(MESSAGE_MAX), botId: z.uuid().nullable().optional(), images: userImageInputsSchema.optional(), submissionId: z.uuid().optional() })
    .refine(value => Boolean(value.text || value.images?.length)).safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'messageRequired' }, 400)
  const images = parsed.data.images?.length ? parsed.data.images : undefined
  if (typeof user[tokenWorkspace] === 'string') {
    if (!await tokenBotAllowed(user, parsed.data.botId ?? null)) return json({ error: 'botNotFound' }, 404)
    // No bot named: the Coordinator of the token's workspace, resolved here where the message enters.
    const botId = await openChatBotId(user, parsed.data.botId)
    try { await recordPersonalSubmission(db, user.id, parsed.data.text, { botId, images, submissionId: parsed.data.submissionId }) }
    catch (error) {
      if (error instanceof ChatFileError) return Response.json({ error: error.code }, { status: error.code === 'notFound' ? 404 : 400 })
      if (error instanceof SubmissionConflictError) return json({ error: 'submissionConflict' }, 409)
      throw error
    }
    afterJob('after:coordinator-wake', () => wakeCoordinator(user.id))
    return json({ queued: true }, 202)
  }
  const result = await sendCoordinatorMessage(parsed.data.text, null, parsed.data.botId ?? null, parsed.data.submissionId, undefined, null, images)
  return result.error ? json(result, 400) : json(result, 202)
}

export const GET = withRequestLog('/api/mobile/chat', handleGET)
export const POST = withRequestLog('/api/mobile/chat', handlePOST)
