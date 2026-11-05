import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { listOwnerBots } from '@/lib/coordinator/coordinator-bot'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { db } from '@/lib/db'
import { agentRuns } from '@/lib/db/schema'
import { botChats } from '@/lib/coordinator/store'
import { chatPreview } from '@/lib/agent-history'
import { chatPreferences } from '@/lib/chat-preferences'
import { listSuggestions } from '@/lib/suggestions/store'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { runsOutsideToken } from '@/lib/tokens/scope'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { ownerListRead } from '@/lib/live/list-read-server'

export const dynamic = 'force-dynamic'

/** A chat's latest message as the one plain line the 对话 list shows; never OpenUI source. */
const homeLine = (text: string | null | undefined) => text ? chatPreview(text) ?? '' : null

const RUNNING = ['queued', 'preparing', 'running', 'finishing'] as const

/**
 * `GET /api/mobile/home`: what the app's home list and drawer show: the person, their
 * workspace, their bots with each chat's latest line as plain text (an empty
 * string for a card with no words; the Coordinator first, marked `coordinator`), and the counts beside
 * 建议 and 线程 (docs/design/mobile.md, "Where it lives"). `live.workspaceId` is the
 * person's own home channel (lib/live/owner-scope.ts) the app listens on for its
 * owner-wide keys; null when there is none (the app then reads once a minute).
 */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const context = await loadWorkspaceContext(undefined, user)
  const recent = and(eq(agentRuns.userId, user.id), sql`${agentRuns.createdAt} > now() - interval '30 days'`)
  // A workspace token counts the threads of its workspace only.
  const outside = user[tokenWorkspace] ? [...await runsOutsideToken(user, (await db.select({ id: agentRuns.id }).from(agentRuns)
    .where(and(recent, inArray(agentRuns.status, [...RUNNING, 'waiting_input'])))).map(row => row.id))] : []
  const [botRows, chats, suggestions, [counts], preferences, live, waitingRows] = await Promise.all([
    // The Coordinator first, marked `coordinator` (lib/coordinator/coordinator-bot.ts listOwnerBots).
    listOwnerBots(user.id, context.workspace.id),
    botChats(user.id),
    listSuggestions(user.id),
    db.select({
      running: sql<number>`count(*) filter (where ${inArray(agentRuns.status, [...RUNNING])})`,
      waiting: sql<number>`count(*) filter (where ${eq(agentRuns.status, 'waiting_input')})`,
    }).from(agentRuns).where(and(recent, outside.length ? notInArray(agentRuns.id, outside) : undefined)),
    chatPreferences(user.id),
    ownerListRead(user.id),
    // Each bot's threads waiting on the person: the home row's waiting mark outranks its unread count.
    db.select({ botId: agentRuns.botId, waiting: sql<number>`count(*)` }).from(agentRuns)
      .where(and(recent, eq(agentRuns.status, 'waiting_input'), outside.length ? notInArray(agentRuns.id, outside) : undefined))
      .groupBy(agentRuns.botId),
  ])
  const waiting = new Map(waitingRows.map(row => [row.botId, Number(row.waiting)]))
  const own = (key: string) => {
    const preference = preferences[key]
    return { hidden: preference?.hidden ?? false, markedUnread: preference?.markedUnread ?? false, pinOrder: preference?.pinOrder ?? null, listOrder: preference?.listOrder ?? null }
  }
  const botIds = new Set(botRows.map(bot => bot.id))
  return json({
    user: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
    workspace: context.workspace,
    workspaces: context.choices,
    bots: botRows.map(bot => ({ ...bot, line: homeLine(chats[bot.id]?.line), at: chats[bot.id]?.at ?? null, working: chats[bot.id]?.working ?? false,
      pinned: preferences[bot.id]?.pinned ?? bot.coordinator, waiting: waiting.get(bot.id) ?? 0, ...own(bot.id) })),
    // The person's own state for each group chat they changed on the home list, by conversation id.
    groupPreferences: Object.fromEntries(Object.entries(preferences).filter(([key]) => !botIds.has(key) && /^[0-9a-f-]{36}$/i.test(key))
      .map(([key, preference]) => [key, { pinned: preference.pinned, ...own(key) }])),
    threads: { running: Number(counts?.running ?? 0), waiting: Number(counts?.waiting ?? 0) },
    suggestions: suggestions.length,
    live: { ownerId: live.ownerId, workspaceId: live.workspaceId },
  })
}

export const GET = withRequestLog('/api/mobile/home', handleGET)
