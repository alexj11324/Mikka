'use server'

import { singleFlight } from '@/lib/single-flight'
import { withDatabaseOperation } from '@/lib/db/egress-sample'
import { desktopHumanSessionId } from '@/lib/desktop-rpc/session'
import { ownerListRead } from '@/lib/live/list-read-server'
import { beginOwnerListRead } from '@/lib/live/revision-read'
import type { ListLiveRead } from '@/lib/live/list-read'

import { cookies, headers } from 'next/headers'
import { afterJob } from '@/lib/background'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { userMessageEvent } from '@/lib/coordinator-events'
import type { UserImageInput } from '@/lib/coordinator/user-attachments'
import { personalSubmissionInput, personalSubmissionRecorded, recordPersonalSubmission, SubmissionConflictError } from '@/lib/coordinator-submission'
import { botChats, chatVersionState, chatView, citationSources, storedReasoning, retryFailedTurn, sendRetryOf, type BotChatSummary, type ChatView } from '@/lib/coordinator/store'
import * as chatStore from '@/lib/coordinator/store'
import { refreshChatMetadata, type UnchangedChat } from '@/lib/coordinator/chat-poll'
import type { CitationSource } from '@/lib/coordinator/citations'
import { reasoningText } from '@/lib/coordinator/stream-response'
import { credentialChatFingerprints } from '@/lib/credentials/chat-guard'
import { and, eq, sql } from 'drizzle-orm'
import { chatBotId, type openChatBotId } from '@/lib/coordinator/coordinator-bot'
import { bots, devices } from '@/lib/db/schema'
import { taskDestinationSchema, type TaskDestination } from '@/lib/task-destination'
import { QUOTE_TEXT_MAX, withQuote, type ArtifactQuote } from '@/lib/artifacts/quote'
import { NOTE_MAX, NOTES_MAX, withBrowserNotes, type BrowserNote } from '@/lib/browser/note'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'
import { coordinatorWelcome } from '@/lib/agent-welcome'
import { claimSuggestion, readClaimedSuggestion } from '@/lib/suggestions/store'
import { suggestionMessage } from '@/lib/suggestions/card'
import { issueMutationsEnabled } from '@/lib/coordinator/issue-tools-enabled'
import { AgentProfileError } from '@/lib/factory/agent-profile-definition'
import { agentProfileReferenceSchema, BUILTIN_AGENT_PROFILE_ID } from '@/lib/factory/agent-profile-reference'
import { cacheReadAction } from '@/lib/cache-read-action'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { actAs } from '@/lib/acting-user'

async function getUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return { ...session.user, [enterprisePrincipal]: { kind: 'session' as const, sessionId: session.session.id } }
}

async function getUserId(): Promise<string> {
  return (await getUser()).id
}

/** `botId` is the chat's bot row, the Coordinator's included. */
export type CoordinatorChat = ChatView & { botId: string; enabled: boolean; version?: string; after?: number; baseCursor?: number; metadataRefresh?: boolean; live?: ListLiveRead }

const botIdSchema = z.uuid().nullable()
const expectedWorkspaceIdSchema = z.uuid().transform(value => value.toLowerCase()).optional()

/**
 * The bot whose chat this is: `botId` if it is one of the person's, or their
 * Coordinator's bot row when the caller names none (the Coordinator's entry
 * in the bot list).
 */
async function ownBot(user: Parameters<typeof openChatBotId>[0], botId: string | null | undefined, expectedWorkspaceId?: string): Promise<{ id: string; name: string; coordinator: boolean; workspaceId: string }> {
  const userId = user.id
  const parsed = botIdSchema.safeParse(botId ?? null)
  const expected = expectedWorkspaceIdSchema.safeParse(expectedWorkspaceId)
  if (!parsed.success || !expected.success) throw new ActionFailureError('validationGeneric')
  // No bot named: the Coordinator of the workspace the person has open.
  const context = await loadWorkspaceContext(undefined, user)
  // A captured expectation cannot select or authorize a workspace. Refuse it
  // before ensuring a Coordinator, then resolve in this same trusted context.
  if (expected.data !== undefined && expected.data !== context.workspace.id) throw new ActionFailureError('workspaceAccessDenied')
  const id = await chatBotId(userId, parsed.data, context.workspace.id)
  const [bot] = await db.select({ id: bots.id, name: bots.name, workspaceId: bots.workspaceId, coordinator: sql<boolean>`exists (select 1 from coordinator_bots cb where cb."botId" = ${bots.id})` })
    .from(bots).where(and(eq(bots.id, id), eq(bots.ownerId, userId), eq(bots.workspaceId, context.workspace.id))).limit(1)
  if (!bot) throw new ActionFailureError('botNotFound')
  return bot
}

/** The person's chat with their Coordinator, or with one of their bots: every bot runs on the same harness. */
export async function getCoordinatorChat(botId: string | null = null): Promise<CoordinatorChat> {
  return withDatabaseOperation('/actions/coordinator/chat', () => readFullChat(botId))
}

async function readFullChat(botId: string | null): Promise<CoordinatorChat> {
  const user = await getUser()
  const userId = user.id
  const bot = await ownBot(user, botId)
  const enabled = await coordinatorEnabled(user.id, bot.id)
  // Before the chat: a push at this revision or below is already in what follows.
  const begun = await beginOwnerListRead(userId, [], [{ kind: 'bot_chat', id: bot.id }])
  const { chat, expiries, observedAt } = await chatStore.chatViewState(userId, 200, bot.id)
  // The legacy/mobile full reader retains the same authorized home and
  // deadline as incremental reads; web sidebars use chat summaries instead.
  const live = await ownerListRead(userId, expiries, observedAt, begun)
  // Without a Coordinator here nothing is coming, so do not show one working.
  return { ...chat, botId: bot.id, enabled, working: enabled && chat.working, live }
}

const versionSchema = z.string().regex(/^[0-9a-f]{32}$/).optional()
const continuationSchema = z.object({ after: z.number().int().min(0), cursor: z.number().int().min(0), prefix: z.string().regex(/^[0-9a-f]{32}$/), restoreToolMetadata: z.literal(true).optional(), sourceIds: z.array(z.uuid()).max(400).optional(), artifactIds: z.array(z.uuid()).max(400).optional() }).optional()

/**
 * The chat for a poll that already shows version `known`: only its live state
 * when nothing in the conversation changed, the whole chat otherwise.
 */
export async function pollCoordinatorChat(botId: string | null = null, known?: string, continuation?: z.infer<typeof continuationSchema>): Promise<CoordinatorChat | UnchangedChat> {
  return withDatabaseOperation('/actions/coordinator/poll', () => readCoordinatorChat(botId, known, continuation))
}

/** Expected authorization failures cross the Server Action boundary as codes,
 * so a local cache can erase them instead of retaining data under a redacted
 * production exception. The established reader and cursor stay unchanged. */
export async function syncCoordinatorChat(botId: string | null = null, known?: string, continuation?: z.infer<typeof continuationSchema>): Promise<ActionResult<{ chat: CoordinatorChat | UnchangedChat }>> {
  return cacheReadAction(async () => ({ chat: await pollCoordinatorChat(botId, known, continuation) }))
}

async function readCoordinatorChat(botId: string | null, known?: string, continuation?: z.infer<typeof continuationSchema>): Promise<CoordinatorChat | UnchangedChat> {
  // Each request is authorized on its own: the session and its ownership of this bot.
  const user = await getUser()
  const bot = await ownBot(user, botId)
  const enabled = await coordinatorEnabled(user.id, bot.id)
  const parsed = versionSchema.safeParse(known)
  const proof = continuationSchema.safeParse(continuation)
  const previous = proof.success && proof.data ? { ...proof.data,
    sourceIds: [...new Set(proof.data.sourceIds ?? [])].sort(), artifactIds: [...new Set(proof.data.artifactIds ?? [])].sort(),
  } : undefined
  const heldVersion = parsed.success ? parsed.data : undefined
  // Before the chat: a push at this revision or below is already in what follows.
  const begun = await beginOwnerListRead(user.id, [], [{ kind: 'bot_chat', id: bot.id }])
  const { expiries, observedAt, ...current } = await chatVersionState(user.id, 200, bot.id)
  // The owner's home channel says when to read again; a lease running out is the one change with no write.
  const live = await ownerListRead(user.id, expiries, observedAt, begun)
  // Each request observes the current version before joining: a deletion or a
  // new turn cannot join an older transcript still being read. Normalize only
  // the validated, bounded cursor; a full read and a saved tail stay distinct.
  const shared = await singleFlight(['/actions/coordinator/poll', user.id, bot.id, current.version, heldVersion ?? null,
    previous ? JSON.stringify(previous) : null], async (): Promise<CoordinatorChat | UnchangedChat> => {
    if (heldVersion === current.version && !previous?.restoreToolMetadata) return { unchanged: true, ...current, botId: bot.id, enabled, working: enabled && current.working, live }
    const chat = await chatStore.chatUpdate(user.id, bot.id, previous)
    // Carry the leader's revision, read before its transcript. A joiner's newer
    // revision must never acknowledge a write absent from this shared data.
    return { ...chat, version: current.version, botId: bot.id, enabled, working: enabled && chat.working, live }
  })
  // This stays outside the flight, after awaiting it: cited task and artifact
  // access may have changed while another request was reading the transcript.
  return refreshChatMetadata(shared, previous, async ({ sourceIds, artifactIds }) => {
    const { artifactSummaries } = await import('@/lib/artifacts/store')
    const [sources, artifacts] = await Promise.all([
      citationSources({ ...user, [tokenWorkspace]: bot.workspaceId }, sourceIds.map(id => `[[issue:${id}]] [[run:${id}]]`)),
      artifactSummaries({ ...user, [tokenWorkspace]: bot.workspaceId }, artifactIds),
    ])
    return { sources, artifacts }
  })
}

/** A bounded older page overlaps the first rendered item, preserving multi-step reply grouping. The app's pages are
 * `CHAT_FIRST_PAGE` long; at most 200. */
export async function coordinatorHistory(botId: string | null, through: number, limit = 200): Promise<ChatView> {
  z.number().int().min(0).parse(through)
  z.number().int().min(1).max(200).parse(limit)
  return withDatabaseOperation('/actions/coordinator/history', async () => {
    const user = await getUser()
    const bot = await ownBot(user, botId)
    return chatView(user.id, limit, bot.id, { through })
  })
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

const citedIdsSchema = z.array(z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)).min(1).max(50)

/**
 * The issues and runs a reply still streaming cites, that this person can see: the chat's own sources come
 * from stored replies only, so a task or thread the reply has just made would otherwise show as its marker.
 */
export async function coordinatorCitationSources(ids: readonly string[]): Promise<Record<string, CitationSource>> {
  const parsed = citedIdsSchema.safeParse(ids)
  if (!parsed.success) return {}
  const user = await getUser()
  const context = await loadWorkspaceContext(undefined, user)
  return citationSources({ ...user, [tokenWorkspace]: context.workspace.id }, [parsed.data.join(' ')])
}

const reasoningPositionsSchema = z.array(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)).min(1).max(50)

/**
 * What a stored reply thought, for the chat's 「思考了」 when the person opens it: the readable reasoning of the
 * person's own messages at `positions` in this bot's chat, masked as the live stream masks it. Null when there is none.
 */
export async function coordinatorReasoning(botId: string | null, positions: readonly number[]): Promise<string | null> {
  const parsed = reasoningPositionsSchema.safeParse(positions)
  if (!parsed.success) return null
  const user = await getUser()
  const bot = await ownBot(user, botId)
  const fingerprints = await credentialChatFingerprints(user.id)
  const texts = (await storedReasoning(user.id, bot.id, parsed.data)).flatMap(text => reasoningText(user.id, text, fingerprints) ?? [])
  return texts.length ? texts.join('\n\n') : null
}

/** Each bot's latest line and whether it is answering, for the bot list. */
export async function botChatSummaries(): Promise<Record<string, BotChatSummary>> {
  const user = await getUser()
  const context = await loadWorkspaceContext(undefined, user)
  return botChats({ ...user, [tokenWorkspace]: context.workspace.id })
}

/** Same owner-wide summaries, including the actual working-state deadline. */
export async function pollBotChatSummaries() {
  return withDatabaseOperation('/actions/coordinator/summaries', readBotChatSummaries)
}

async function readBotChatSummaries() {
  const user = await getUser()
  const ownerId = user.id
  const context = await loadWorkspaceContext(undefined, user)
  const begun = await beginOwnerListRead(ownerId, ['bot_chat_list'])
  const snapshot = await chatStore.botChatSnapshot({ ...user, [tokenWorkspace]: context.workspace.id })
  return { items: snapshot.items, live: await ownerListRead(ownerId, snapshot.expiries, snapshot.observedAt, begun) }
}

/** Sends a message to the Coordinator or one of the person's bots, with a quote from an artifact and notes from the browser in front if given; the reply shows up in the chat. */
export async function sendCoordinatorMessage(text: string, quote?: ArtifactQuote | null, botId: string | null = null, submissionId?: string, taskDestination?: TaskDestination, notes?: readonly BrowserNote[] | null, images?: readonly UserImageInput[], retryOf?: number, profileId?: string, expectedWorkspaceId?: string): Promise<ActionResult<{ queued: true }>> {
  return runAction(async () => {
    const requestHeaders=await headers()
    const session=await auth.api.getSession({headers:requestHeaders})
    if(!session?.user)throw new ActionFailureError('authRequired')
    const userId=session.user.id
    let humanSessionId:string|undefined=desktopHumanSessionId()===session.session.id?session.session.id:undefined
    if(!requestHeaders.has('authorization')&&requestHeaders.get('cookie')){
      try{const origin=new URL(requestHeaders.get('origin')??'');const host=requestHeaders.get('x-forwarded-host')??requestHeaders.get('host')
        if(['http:','https:'].includes(origin.protocol)&&origin.host===host)humanSessionId=session.session.id
      }catch{/* Missing/malformed origin is no approval provenance. */}
    }
    const bot = await ownBot(session.user, botId, expectedWorkspaceId)
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
    const profile = agentProfileReferenceSchema.optional().safeParse(profileId)
    if (!profile.success) throw new ActionFailureError('validationGeneric')
    const taskSubmission = Boolean(destination.data || profile.data)
    if (profile.data && profile.data !== BUILTIN_AGENT_PROFILE_ID) {
      try {
        const row = await (await import('@/lib/factory/agent-profile-store')).readProfileRow((await import('@/lib/db')).pool, { ownerId: userId, workspaceId: await (await import('@/lib/execution-settings')).executionWorkspace(userId, bot.id) }, profile.data)
        if (row.archivedAt || !row.definition.enabled) throw new ActionFailureError('runInvalid')
      } catch (error) { if (error instanceof AgentProfileError) throw new ActionFailureError('runInvalid'); throw error }
    }
    if (taskSubmission && !issueMutationsEnabled()) throw new ActionFailureError('issueToolsDisabled')
    // A new task is handed to the Coordinator to create; with no Coordinator here, say so instead of queueing it silently.
    if (taskSubmission && !await coordinatorEnabled(userId, bot.id)) throw new ActionFailureError('coordinatorUnavailable')
    if (taskSubmission && !parsed.data.submissionId) throw new ActionFailureError('validationGeneric')
    if (destination.data?.kind === 'device') {
      const [device] = await db.select({ id: devices.id }).from(devices)
        .where(and(eq(devices.id, destination.data.deviceId), eq(devices.ownerId, userId), eq(devices.kind, 'local'), eq(devices.enabled, true))).limit(1)
      if (!device) throw new ActionFailureError('deviceNotFound')
    }
    // 重新发送 on a failed message (retryOf: its position) retries it in place: that message is marked and the
    // new attempt stands for it (store.sendRetryOf). A position that does not qualify is ignored.
    const retried = z.number().int().positive().optional().safeParse(retryOf)
    const message = withQuote(withNotes, quoted?.data)
    // Validate files before a retry holds its message row/connection; concurrent retries must not exhaust the pool.
    if (message.includes('[mikka-file:')) { const { validateChatFiles } = await import('@/lib/chat-attachments/store'); try { await validateChatFiles(userId, { kind: 'bot', id: bot.id }, message) } catch { throw new ActionFailureError('messageRequired') } }
    const reader = { id: userId, [tokenWorkspace]: bot.workspaceId, [enterprisePrincipal]: { kind: 'session' as const, sessionId: session.session.id } }
    const record = (executor: Parameters<typeof recordPersonalSubmission>[0]) => actAs(reader, () => recordPersonalSubmission(executor, userId, message, { botId: bot.id, submissionId: parsed.data.submissionId, images: parsed.data.images, taskDestination: destination.data, profileId: profile.data, filesValidated: true, ...(humanSessionId ? { humanSessionId } : {}) }))
    try {
      // Already retried (a double click, two sends at once): nothing more is sent.
      if (retried.success && retried.data !== undefined) { if (await sendRetryOf(userId, bot.id, retried.data, record) === null) return { queued: true as const } }
      else await record(db)
    }
    catch (error) {
      if (error instanceof SubmissionConflictError) throw new ActionFailureError('submissionConflict')
      throw error
    }
    afterJob('after:coordinator-wake', () => wakeCoordinator(userId))
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
    const bot = await ownBot(session.user, botId)
    if (!await coordinatorEnabled(session.user.id, bot.id)) return { queued: false }
    const chat = await chatView(session.user.id, 1, bot.id)
    if (chat.items.length || chat.working || chat.error) return { queued: false }
    const locale = (await cookies()).get('NEXT_LOCALE')?.value ?? 'zh-CN'
    await recordCoordinatorEvent(db, userMessageEvent(session.user.id, coordinatorWelcome(session.user.name ?? '', locale, bot.coordinator ? undefined : bot.name), { botId: bot.id }))
    afterJob('after:coordinator-wake', () => wakeCoordinator(session.user.id))
    return { queued: true }
  })
}

/** 停止 in a chat: the turn working there ends, keeping what its reply had said, marked 已停止. */
export async function stopCoordinatorTurn(botId: string | null = null): Promise<ActionResult<{ stopped: boolean }>> {
  return runAction(async () => {
    const user = await getUser()
    const bot = await ownBot(user, botId)
    const { stopChatTurn } = await import('@/lib/coordinator/stop-turn')
    return { stopped: await stopChatTurn(user.id, bot.id) }
  })
}

/** 重试 on a failed reply: the same turn again, once per click; the chat shows its normal working state. */
export async function retryCoordinatorTurn(botId: string | null = null): Promise<ActionResult<{ queued: true } | { queued: false; reason: 'unavailable' | 'working' | 'nothingToRetry' }>> {
  return runAction(async () => {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) throw new ActionFailureError('authRequired')
    const bot = await ownBot(session.user, botId)
    if (!await coordinatorEnabled(session.user.id, bot.id)) return { queued: false as const, reason: 'unavailable' as const }
    const queued = await retryFailedTurn(session.user.id, bot.id)
    if (queued) {
      afterJob('after:coordinator-wake', () => wakeCoordinator(session.user.id))
      return { queued: true as const }
    }
    const current = await chatView(session.user.id, 1, bot.id)
    return { queued: false as const, reason: current.working ? 'working' as const : 'nothingToRetry' as const }
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
    try {
      await db.transaction(async tx => {
        const claimed = await claimSuggestion(userId, id.data, tx)
        const item = claimed ?? await readClaimedSuggestion(userId, id.data, tx)
        if (!item) throw new ActionFailureError('suggestionNotFound')
        if (!await coordinatorEnabled(userId, item.botId)) throw new ActionFailureError('coordinatorUnavailable')
        const text = suggestionMessage({ source: item.source, action: item.action, title: item.title, actionTitle: item.actionTitle, actor: item.actor, url: item.url })
        // The suggestion stored its Coordinator bot row when it was made (null only on an older one).
        if (claimed) await recordPersonalSubmission(tx, userId, text, { submissionId: item.id, botId: item.botId })
        else if (!await personalSubmissionRecorded(tx, userId, text, item.id, item.botId)) throw new ActionFailureError('suggestionNotFound')
      })
    } catch (error) {
      if (error instanceof SubmissionConflictError) throw new ActionFailureError('submissionConflict')
      throw error
    }
    afterJob('after:coordinator-wake', () => wakeCoordinator(userId))
    return { queued: true as const }
  })
}

/** Whether the new-task dialog can create a task; it explains itself when this is off. */
export async function issueCreationAvailable(): Promise<boolean> {
  return issueMutationsEnabled()
}
