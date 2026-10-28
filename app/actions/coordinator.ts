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
import { personalSubmissionInput, personalSubmissionRecorded, recordPersonalSubmission, SubmissionConflictError } from '@/lib/coordinator-submission'
import { botChats, chatView, type BotChatSummary, type ChatView } from '@/lib/coordinator/store'
import { and, eq } from 'drizzle-orm'
import { bots } from '@/lib/db/schema'
import { QUOTE_TEXT_MAX, withQuote, type ArtifactQuote } from '@/lib/artifacts/quote'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'
import { coordinatorWelcome } from '@/lib/agent-welcome'
import { claimSuggestion, readClaimedSuggestion } from '@/lib/suggestions/store'
import { suggestionMessage } from '@/lib/suggestions/card'

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

/** Each bot's latest line and whether it is answering, for the bot list. */
export async function botChatSummaries(): Promise<Record<string, BotChatSummary>> {
  return botChats(await getUserId())
}

/** Sends a message to the Coordinator or one of the person's bots, with a quote from an artifact in front if given; the reply shows up in the chat. */
export async function sendCoordinatorMessage(text: string, quote?: ArtifactQuote | null, botId: string | null = null, submissionId?: string): Promise<ActionResult<{ queued: true }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const bot = await ownBot(userId, botId)
    const parsed = personalSubmissionInput.safeParse({ text, submissionId })
    if (!parsed.success) throw new ActionFailureError('messageRequired')
    const quoted = quote ? quoteSchema.safeParse(quote) : null
    if (quoted && !quoted.success) throw new ActionFailureError('messageRequired')
    try { await recordPersonalSubmission(db, userId, withQuote(parsed.data.text, quoted?.data), { botId: bot?.id ?? null, submissionId: parsed.data.submissionId }) }
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

/**
 * A tapped 建议 card goes to the Coordinator at once, with no composer step
 * (R-21): the message is the card itself, which the chat draws as the same
 * card and the Coordinator reads as the task. What came from the source app
 * stays quoted inside the card (lib/suggestions/card.ts), never loose in the
 * message. Sending and taking the card off 建议 commit together; with no
 * Coordinator to read it, nothing is sent and the card stays.
 */
export async function sendSuggestion(suggestionId: string): Promise<ActionResult<{ queued: true }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const id = z.uuid().safeParse(suggestionId)
    if (!id.success) throw new ActionFailureError('validationGeneric')
    if (!coordinatorEnabled()) throw new ActionFailureError('coordinatorUnavailable')
    try {
      await db.transaction(async tx => {
        const claimed = await claimSuggestion(userId, id.data, tx)
        const item = claimed ?? await readClaimedSuggestion(userId, id.data, tx)
        if (!item) throw new ActionFailureError('suggestionNotFound')
        const text = suggestionMessage({ source: item.source, action: item.action, title: item.title, actionTitle: item.actionTitle, actor: item.actor, url: item.url })
        if (claimed) await recordPersonalSubmission(tx, userId, text, { submissionId: item.id })
        else if (!await personalSubmissionRecorded(tx, userId, text, item.id)) throw new ActionFailureError('suggestionNotFound')
      })
    } catch (error) {
      if (error instanceof SubmissionConflictError) throw new ActionFailureError('submissionConflict')
      throw error
    }
    after(() => wakeCoordinator(userId))
    return { queued: true as const }
  })
}
