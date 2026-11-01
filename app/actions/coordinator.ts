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
import type { UserImageInput } from '@/lib/coordinator/user-attachments'
import { personalSubmissionInput, personalSubmissionRecorded, recordPersonalSubmission, SubmissionConflictError } from '@/lib/coordinator-submission'
import { botChats, chatView, retryFailedTurn, type BotChatSummary, type ChatView } from '@/lib/coordinator/store'
import { and, eq, sql } from 'drizzle-orm'
import { coordinatorBot } from '@/lib/coordinator/coordinator-bot'
import { bots, devices } from '@/lib/db/schema'
import { taskDestinationSchema, type TaskDestination } from '@/lib/task-destination'
import { QUOTE_TEXT_MAX, withQuote, type ArtifactQuote } from '@/lib/artifacts/quote'
import { NOTE_MAX, NOTES_MAX, withBrowserNotes, type BrowserNote } from '@/lib/browser/note'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'
import { coordinatorWelcome } from '@/lib/agent-welcome'
import { claimSuggestion, readClaimedSuggestion } from '@/lib/suggestions/store'
import { suggestionMessage } from '@/lib/suggestions/card'
import { issueMutationsEnabled } from '@/lib/coordinator/issue-tools-enabled'

async function getUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
}

/** `botId` is the chat's bot row, the Coordinator's included. */
export type CoordinatorChat = ChatView & { botId: string; enabled: boolean }

const botIdSchema = z.uuid().nullable()

/**
 * The bot whose chat this is: `botId` if it is one of the person's, or their
 * Coordinator's bot row when the caller names none (the Coordinator's entry
 * in the bot list).
 */
async function ownBot(userId: string, botId: string | null | undefined): Promise<{ id: string; name: string; coordinator: boolean }> {
  const parsed = botIdSchema.safeParse(botId ?? null)
  if (!parsed.success) throw new ActionFailureError('validationGeneric')
  const id = parsed.data ?? (await coordinatorBot(userId)).botId
  const [bot] = await db.select({ id: bots.id, name: bots.name, coordinator: sql<boolean>`exists (select 1 from coordinator_bots cb where cb."botId" = ${bots.id})` })
    .from(bots).where(and(eq(bots.id, id), eq(bots.ownerId, userId))).limit(1)
  if (!bot) throw new ActionFailureError('validationGeneric')
  return bot
}

/** The person's chat with their Coordinator, or with one of their bots: every bot runs on the same harness. */
export async function getCoordinatorChat(botId: string | null = null): Promise<CoordinatorChat> {
  const userId = await getUserId()
  const bot = await ownBot(userId, botId)
  const enabled = coordinatorEnabled()
  const chat = await chatView(userId, 200, bot.id)
  // Without a Coordinator here nothing is coming, so do not show one working.
  return { ...chat, botId: bot.id, enabled, working: enabled && chat.working }
}

const quoteSchema = z.object({
  artifactId: z.uuid(), version: z.number().int().min(1), kind: z.enum(['text', 'element']),
  text: z.string().trim().min(1).max(QUOTE_TEXT_MAX), label: z.string().max(200).optional(), selector: z.string().max(1000).optional(),
})

const notesSchema = z.array(z.object({
  n: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), kind: z.enum(['element', 'region']), url: z.url({ protocol: /^https?$/ }).max(2000),
  label: z.string().trim().min(1).max(200), note: z.string().trim().min(1).max(NOTE_MAX),
  selector: z.string().max(1000).optional(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number().min(0), height: z.number().min(0), viewportWidth: z.number().min(0), viewportHeight: z.number().min(0) }).optional(),
}).strict()).max(NOTES_MAX)

/** Each bot's latest line and whether it is answering, for the bot list. */
export async function botChatSummaries(): Promise<Record<string, BotChatSummary>> {
  return botChats(await getUserId())
}

/** Sends a message to the Coordinator or one of the person's bots, with a quote from an artifact and notes from the browser in front if given; the reply shows up in the chat. */
export async function sendCoordinatorMessage(text: string, quote?: ArtifactQuote | null, botId: string | null = null, submissionId?: string, taskDestination?: TaskDestination, notes?: readonly BrowserNote[] | null, images?: readonly UserImageInput[]): Promise<ActionResult<{ queued: true }>> {
  return runAction(async () => {
    const requestHeaders=await headers()
    const session=await auth.api.getSession({headers:requestHeaders})
    if(!session?.user)throw new ActionFailureError('authRequired')
    const userId=session.user.id
    let humanSessionId:string|undefined
    if(!requestHeaders.has('authorization')&&requestHeaders.get('cookie')){
      try{const origin=new URL(requestHeaders.get('origin')??'');const host=requestHeaders.get('x-forwarded-host')??requestHeaders.get('host')
        if(['http:','https:'].includes(origin.protocol)&&origin.host===host)humanSessionId=session.session.id
      }catch{/* Missing/malformed origin is no approval provenance. */}
    }
    const bot = await ownBot(userId, botId)
    const parsed = personalSubmissionInput.safeParse({ text, submissionId, ...(images?.length ? { images } : {}) })
    if (!parsed.success) throw new ActionFailureError('messageRequired')
    const quoted = quote ? quoteSchema.safeParse(quote) : null
    if (quoted && !quoted.success) throw new ActionFailureError('messageRequired')
    const noted = notes != null ? notesSchema.safeParse(notes) : null
    if (noted && !noted.success) throw new ActionFailureError('messageRequired')
    const withNotes = withBrowserNotes(parsed.data.text, noted?.data)
    if (withNotes === null) throw new ActionFailureError('messageTooLong')
    const destination = taskDestinationSchema.optional().safeParse(taskDestination)
    if (!destination.success) throw new ActionFailureError('validationGeneric')
    if (destination.data && !issueMutationsEnabled()) throw new ActionFailureError('issueToolsDisabled')
    // A new task is handed to the Coordinator to create; with no Coordinator here, say so instead of queueing it silently.
    if (destination.data && !coordinatorEnabled()) throw new ActionFailureError('coordinatorUnavailable')
    if (destination.data && !parsed.data.submissionId) throw new ActionFailureError('validationGeneric')
    if (destination.data?.kind === 'device') {
      const [device] = await db.select({ id: devices.id }).from(devices)
        .where(and(eq(devices.id, destination.data.deviceId), eq(devices.ownerId, userId), eq(devices.kind, 'local'), eq(devices.enabled, true))).limit(1)
      if (!device) throw new ActionFailureError('deviceNotFound')
    }
    try { await recordPersonalSubmission(db, userId, withQuote(withNotes, quoted?.data), { botId: bot.id, submissionId: parsed.data.submissionId, images: parsed.data.images, taskDestination: destination.data, ...(humanSessionId ? { humanSessionId } : {}) }) }
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
    const chat = await chatView(session.user.id, 1, bot.id)
    if (chat.items.length || chat.working || chat.error) return { queued: false }
    const locale = (await cookies()).get('NEXT_LOCALE')?.value ?? 'zh-CN'
    await recordCoordinatorEvent(db, userMessageEvent(session.user.id, coordinatorWelcome(session.user.name ?? '', locale, bot.coordinator ? undefined : bot.name), { botId: bot.id }))
    after(() => wakeCoordinator(session.user.id))
    return { queued: true }
  })
}

/** 重试 on a failed reply: the same turn again, once per click; the chat shows its normal working state. */
export async function retryCoordinatorTurn(botId: string | null = null): Promise<ActionResult<{ queued: boolean }>> {
  return runAction(async () => {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) throw new ActionFailureError('authRequired')
    const bot = await ownBot(session.user.id, botId)
    if (!coordinatorEnabled()) return { queued: false }
    const queued = await retryFailedTurn(session.user.id, bot.id)
    if (queued) after(() => wakeCoordinator(session.user.id))
    return { queued }
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
        // The suggestion stored its Coordinator bot row when it was made (null only on an older one).
        if (claimed) await recordPersonalSubmission(tx, userId, text, { submissionId: item.id, botId: item.botId })
        else if (!await personalSubmissionRecorded(tx, userId, text, item.id, item.botId)) throw new ActionFailureError('suggestionNotFound')
      })
    } catch (error) {
      if (error instanceof SubmissionConflictError) throw new ActionFailureError('submissionConflict')
      throw error
    }
    after(() => wakeCoordinator(userId))
    return { queued: true as const }
  })
}

/** Whether the new-task dialog can create a task; it explains itself when this is off. */
export async function issueCreationAvailable(): Promise<boolean> {
  return issueMutationsEnabled()
}
