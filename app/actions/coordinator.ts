'use server'

import { cookies, headers } from 'next/headers'
import { after } from 'next/server'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { userMessageEvent } from '@/lib/coordinator-events'
import { personalSubmissionInput, recordPersonalSubmission, SubmissionConflictError } from '@/lib/coordinator-submission'
import { botChats, chatView, type BotChatSummary, type ChatView } from '@/lib/coordinator/store'
import { and, eq } from 'drizzle-orm'
import { bots } from '@/lib/db/schema'
import { QUOTE_TEXT_MAX, withQuote, type ArtifactQuote } from '@/lib/artifacts/quote'
import { NOTE_MAX, NOTES_MAX, withBrowserNotes, type BrowserNote } from '@/lib/browser/note'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'
import { coordinatorWelcome } from '@/lib/agent-welcome'

async function getUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
}

export type CoordinatorChat = ChatView & { enabled: boolean }

const botIdSchema = z.uuid().nullable()

/** The bot `botId` if it is one of the person's; null stays the Coordinator. */
async function ownBot(userId: string, botId: string | null | undefined): Promise<{ id: string; name: string } | null> {
  const parsed = botIdSchema.safeParse(botId ?? null)
  if (!parsed.success) throw new ActionFailureError('validationGeneric')
  if (!parsed.data) return null
  const [bot] = await db.select({ id: bots.id, name: bots.name }).from(bots).where(and(eq(bots.id, parsed.data), eq(bots.ownerId, userId))).limit(1)
  if (!bot) throw new ActionFailureError('validationGeneric')
  return bot
}

/** The person's chat with their Coordinator, or with one of their bots: every bot runs on the same harness. */
export async function getCoordinatorChat(botId: string | null = null): Promise<CoordinatorChat> {
  const userId = await getUserId()
  const bot = await ownBot(userId, botId)
  const enabled = coordinatorEnabled()
  const chat = await chatView(userId, 200, bot?.id ?? null)
  // Without a Coordinator here nothing is coming, so do not show one working.
  return { ...chat, enabled, working: enabled && chat.working }
}

const quoteSchema = z.object({
  artifactId: z.uuid(), version: z.number().int().min(1), kind: z.enum(['text', 'element']),
  text: z.string().trim().min(1).max(QUOTE_TEXT_MAX), label: z.string().max(200).optional(), selector: z.string().max(1000).optional(),
})

const notesSchema = z.array(z.object({
  n: z.number().int().min(1).max(99), kind: z.enum(['element', 'region']), url: z.url({ protocol: /^https?$/ }).max(2000),
  label: z.string().trim().min(1).max(200), note: z.string().trim().min(1).max(NOTE_MAX),
  selector: z.string().max(1000).optional(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number().min(0), height: z.number().min(0), viewportWidth: z.number().min(0), viewportHeight: z.number().min(0) }).optional(),
}).strict()).max(NOTES_MAX)

/** Each bot's latest line and whether it is answering, for the bot list. */
export async function botChatSummaries(): Promise<Record<string, BotChatSummary>> {
  return botChats(await getUserId())
}

/** Sends a message to the Coordinator or one of the person's bots, with a quote from an artifact and notes from the browser in front if given; the reply shows up in the chat. */
export async function sendCoordinatorMessage(text: string, quote?: ArtifactQuote | null, botId: string | null = null, submissionId?: string, notes?: readonly BrowserNote[] | null): Promise<ActionResult<{ queued: true }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const bot = await ownBot(userId, botId)
    const parsed = personalSubmissionInput.safeParse({ text, submissionId })
    if (!parsed.success) throw new ActionFailureError('messageRequired')
    const quoted = quote ? quoteSchema.safeParse(quote) : null
    if (quoted && !quoted.success) throw new ActionFailureError('messageRequired')
    const noted = notes?.length ? notesSchema.safeParse(notes) : null
    if (noted && !noted.success) throw new ActionFailureError('messageRequired')
    const withNotes = withBrowserNotes(parsed.data.text, noted?.data)
    if (withNotes === null) throw new ActionFailureError('messageTooLong')
    try { await recordPersonalSubmission(db, userId, withQuote(withNotes, quoted?.data), { botId: bot?.id ?? null, submissionId: parsed.data.submissionId }) }
    catch (error) {
      if (error instanceof SubmissionConflictError) throw new ActionFailureError('submissionConflict')
      throw error
    }
    after(() => wakeCoordinator(userId))
    return { queued: true as const }
  })
}

/**
 * An empty chat asks its bot for a welcome, the Coordinator's included: a
 * greeting and one question about where to start. Once only: nothing happens
 * when the chat already has messages or anything waiting.
 */
export async function welcomeCoordinator(botId: string | null = null): Promise<ActionResult<{ queued: boolean }>> {
  return runAction(async () => {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) throw new ActionFailureError('authRequired')
    const bot = await ownBot(session.user.id, botId)
    if (!coordinatorEnabled()) return { queued: false }
    const chat = await chatView(session.user.id, 1, bot?.id ?? null)
    if (chat.items.length || chat.working) return { queued: false }
    const locale = (await cookies()).get('NEXT_LOCALE')?.value ?? 'zh-CN'
    await recordCoordinatorEvent(db, userMessageEvent(session.user.id, coordinatorWelcome(session.user.name ?? '', locale, bot?.name), { botId: bot?.id ?? null }))
    after(() => wakeCoordinator(session.user.id))
    return { queued: true }
  })
}
