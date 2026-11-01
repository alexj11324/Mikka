import { and, eq, inArray, sql } from 'drizzle-orm'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { db } from '@/lib/db'
import { agentRuns, bots } from '@/lib/db/schema'
import { botChats } from '@/lib/coordinator/store'
import { chatPreview } from '@/lib/agent-history'
import { chatPreferences } from '@/lib/chat-preferences'
import { listSuggestions } from '@/lib/suggestions/store'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'

export const dynamic = 'force-dynamic'

/** A chat's latest message as the one plain line the 对话 list shows; never OpenUI source. */
const homeLine = (text: string | null | undefined) => text ? chatPreview(text) ?? '' : null

const RUNNING = ['queued', 'preparing', 'running', 'finishing'] as const

/**
 * `GET /api/mobile/home`: what the app's drawer shows: the person, their
 * workspace, their bots with each chat's latest line as plain text (an empty
 * string for a card with no words), and the counts beside
 * 建议 and 线程 (docs/design/mobile.md, "Where it lives").
 */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const context = await loadWorkspaceContext(undefined, user)
  const [botRows, chats, suggestions, [counts], preferences] = await Promise.all([
    db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape }).from(bots)
      .where(and(eq(bots.ownerId, user.id), eq(bots.workspaceId, context.workspace.id), eq(bots.kind, 'bot'))).orderBy(bots.createdAt),
    botChats(user.id),
    listSuggestions(user.id),
    db.select({
      running: sql<number>`count(*) filter (where ${inArray(agentRuns.status, [...RUNNING])})`,
      waiting: sql<number>`count(*) filter (where ${eq(agentRuns.status, 'waiting_input')})`,
    }).from(agentRuns).where(and(eq(agentRuns.userId, user.id), sql`${agentRuns.createdAt} > now() - interval '30 days'`)),
    chatPreferences(user.id),
  ])
  return json({
    user: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
    workspace: context.workspace,
    workspaces: context.choices,
    bots: botRows.map(bot => ({ ...bot, line: homeLine(chats[bot.id]?.line), at: chats[bot.id]?.at ?? null, working: chats[bot.id]?.working ?? false, pinned: preferences[bot.id]?.pinned ?? false })),
    threads: { running: Number(counts?.running ?? 0), waiting: Number(counts?.waiting ?? 0) },
    suggestions: suggestions.length,
  })
}

export const GET = withRequestLog('/api/mobile/home', handleGET)
