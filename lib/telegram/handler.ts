import { issueVisibility } from '@/lib/issue-visibility'
import 'server-only'

import { createHash } from 'node:crypto'
import { getTranslations } from 'next-intl/server'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import type { Message, SlashCommandEvent, Thread } from 'chat'
import type { TelegramMessage } from '@chat-adapter/telegram'
import { z } from 'zod'
import { db } from '@/lib/db'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { coordinatorBot } from '@/lib/coordinator/coordinator-bot'
import { userMessageEvent } from '@/lib/coordinator-events'
import { coordinatorEnabled } from '@/lib/coordinator/wake'
import { wakeCoordinatorAfterCommit } from '@/lib/coordinator/wake-after-commit'
import { issues, telegramConversations, telegramLinkTokens, telegramLinks } from '@/lib/db/schema'
import { createIssueForUserInTransaction } from '@/lib/issue-create'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { userActor } from '@/lib/activity-actor'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { resolveTaskIdentifierAlias } from '@/lib/task-identity-store'
import { numberedIssueTeamScope } from '@/lib/issue-team-access'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { isIssueTeamAccessAllowed } from '@/lib/issue-team-access-policy'
import { parseTelegramCommand } from './commands'
import { isPostgresUniqueViolation } from './unique-violation'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Locale = 'en' | 'zh-CN'
type Translator = Awaited<ReturnType<typeof getTranslations<'TelegramBot'>>>

const MAX_DRAFT_DESCRIPTION = 20000
const titleSchema = z.string().trim().min(1).max(200)
const uuidSchema = z.uuid()
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

function localeOf(raw: unknown): Locale {
  const languageCode = (raw as TelegramMessage | null)?.from?.language_code?.toLowerCase()
  return languageCode?.startsWith('zh') ? 'zh-CN' : 'en'
}

function messageIdOf(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null
  const messageId = (raw as TelegramMessage).message_id
  return typeof messageId === 'number' && Number.isSafeInteger(messageId) ? messageId : null
}

async function ensureConversation(tx: Transaction, threadId: string, userId: string) {
  let [conversation] = await tx.select().from(telegramConversations).where(eq(telegramConversations.threadId, threadId)).for('update')
  if (!conversation) {
    ;[conversation] = await tx.insert(telegramConversations).values({ threadId, userId }).onConflictDoNothing().returning()
    if (!conversation) [conversation] = await tx.select().from(telegramConversations).where(eq(telegramConversations.threadId, threadId)).for('update')
  }
  if (!conversation) throw new Error('Telegram conversation could not be loaded')
  if (conversation.userId !== userId) {
    const [reset] = await tx.update(telegramConversations).set({
      userId,
      issueId: null,
      draftTitle: null,
      draftDescription: '',
      updatedAt: new Date(),
    }).where(eq(telegramConversations.threadId, threadId)).returning()
    if (!reset) throw new Error('Telegram conversation could not be reset')
    return reset
  }
  return conversation
}

async function pairAccount(input: { token: string; telegramUserId: string; telegramUserName: string; threadId: string }) {
  try {
    const userId = await db.transaction(async tx => {
      const [candidate] = await tx.select({ userId: telegramLinkTokens.userId }).from(telegramLinkTokens)
        .where(and(eq(telegramLinkTokens.tokenHash, hashToken(input.token)), gt(telegramLinkTokens.expiresAt, new Date())))
        .for('update').limit(1)
      if (!candidate) return null
      await tx.insert(telegramLinks).values({
        userId: candidate.userId,
        telegramUserId: input.telegramUserId,
        telegramUserName: input.telegramUserName || null,
      }).onConflictDoUpdate({
        target: telegramLinks.userId,
        set: {
          telegramUserId: input.telegramUserId,
          telegramUserName: input.telegramUserName || null,
          linkedAt: new Date(),
        },
      })
      await tx.delete(telegramLinkTokens).where(eq(telegramLinkTokens.userId, candidate.userId))
      await ensureConversation(tx, input.threadId, candidate.userId)
      return candidate.userId
    })
    return userId ? 'linked' as const : 'invalid' as const
  } catch (error) {
    if (isPostgresUniqueViolation(error)) return 'conflict' as const
    throw error
  }
}

function issueContent(description: string) {
  return {
    type: 'doc' as const,
    content: description.split(/\r?\n/).map(line => line
      ? { type: 'paragraph' as const, content: [{ type: 'text' as const, text: line }] }
      : { type: 'paragraph' as const }),
  }
}

type LabelIssue = Pick<typeof issues.$inferSelect, 'id' | 'userId' | 'scope' | 'content' | 'issuedIdentifier'>

async function issueLabels(tx: Transaction, rows: LabelIssue[]) {
  const identifiers = await taskIdentifiers(rows.map(issue => ({ id: issue.id, ownerId: issue.userId, scope: issue.scope, number: readIssueMetadata(issue.content).number, issuedIdentifier: issue.issuedIdentifier })), tx)
  return new Map(rows.map(issue => [issue.id, identifiers.get(issue.id) ?? issue.id]))
}

async function issueLabel(tx: Transaction, issue: LabelIssue) {
  return (await issueLabels(tx, [issue])).get(issue.id)!
}

function statusLabel(status: string, t: Translator) {
  switch (status) {
    case 'backlog': return t('status.backlog')
    case 'todo': return t('status.todo')
    case 'doing': return t('status.doing')
    case 'review': return t('status.review')
    case 'done': return t('status.done')
    case 'canceled': return t('status.canceled')
    case 'duplicate': return t('status.duplicate')
    default: return t('status.unknown')
  }
}

const issueColumns = { id: issues.id, userId: issues.userId, scope: issues.scope, title: issues.title, status: issues.status,
  content: issueAttrsContent, updatedAt: issues.updatedAt, issuedIdentifier: issues.issuedIdentifier,
}
// Match readIssueMetadata's legacy fallback even when the newer JSON key is
// explicitly null. This predicate also guards the atomic /link write below.
const liveMetadata = sql`coalesce(nullif(${issues.content}->'attrs'->'mikka', 'null'::jsonb), ${issues.content}->'attrs'->'orvilo')->>'deletedAt' is null`

async function permittedTeamIssueIds(userId: string, issueIds: string[]) {
  const scope = await numberedIssueTeamScope(userId, issueIds, { withWorkspaceMembership: true })
  const linked = new Set(scope.links.map(link => link.issueId))
  // This explicit mode preserves issueTeamAccess's workspace membership rule.
  const allowed = scope.workspaceMemberAllowed!
  return new Set(issueIds.filter(id => isIssueTeamAccessAllowed({ linked: linked.has(id), allowed: allowed.has(id) })))
}

async function findAccessibleIssues(tx: Transaction, userId: string, workspaceId: string, match?: { id: string }) {
  const rows = await tx.select(issueColumns).from(issues)
    .where(and(
      (await issueVisibility(userId, false, workspaceId, tx, { withTeamLinks: false })).predicate,
      match ? eq(issues.id, match.id) : undefined,
      liveMetadata,
    ))
    .orderBy(desc(issues.updatedAt))
    .limit(match ? 3 : 10)
  // Recheck exactly these candidates in one current Workspace read, retaining
  // Telegram's existing linked-task permission rule without per-Task queries.
  const allowed = await permittedTeamIssueIds(userId, rows.map(issue => issue.id))
  return rows.flatMap(issue => allowed.has(issue.id)
    && !readIssueMetadata(issue.content).deletedAt
    ? [issue] : [])
}

async function linkAccessibleIssue(tx: Transaction, userId: string, workspaceId: string, issueId: string, threadId: string) {
  if (!(await permittedTeamIssueIds(userId, [issueId])).has(issueId)) return null
  // The alias is only a UUID hint. Reapply current canonical tenant and live
  // Task predicates in the write itself, under the existing Workspace lease
  // and locked conversation; RETURNING avoids a separate candidate read.
  const [issue] = await tx.update(telegramConversations).set({ issueId: issues.id, updatedAt: new Date() })
    .from(issues).where(and(
      eq(telegramConversations.threadId, threadId), eq(telegramConversations.userId, userId),
      eq(issues.id, issueId),
      (await issueVisibility(userId, false, workspaceId, tx, { withTeamLinks: false })).predicate,
      liveMetadata,
    )).returning(issueColumns)
  return issue ?? null
}

async function handleCommand(tx: Transaction, conversation: typeof telegramConversations.$inferSelect, userId: string, workspaceId: string, command: { name: string; args: string }, t: Translator): Promise<string> {
  switch (command.name) {
    case 'help':
    case 'start':
      return t('help')
    case 'new': {
      const title = titleSchema.safeParse(command.args)
      if (!title.success) return t('titleRequired')
      await tx.update(telegramConversations).set({
        issueId: null,
        draftTitle: title.data,
        draftDescription: '',
        updatedAt: new Date(),
      }).where(eq(telegramConversations.threadId, conversation.threadId))
      return t('draftStarted', { title: title.data })
    }
    case 'cancel':
      if (!conversation.draftTitle) return t('noDraft')
      await tx.update(telegramConversations).set({ draftTitle: null, draftDescription: '', updatedAt: new Date() })
        .where(eq(telegramConversations.threadId, conversation.threadId))
      return t('draftDiscarded')
    case 'confirm': {
      if (!conversation.draftTitle) return t('startDraft')
      const issue = await createIssueForUserInTransaction(tx, userId, {
        title: conversation.draftTitle,
        content: issueContent(conversation.draftDescription),
        status: 'backlog',
        priority: 'normal',
      }, userActor(userId), { workspaceId })
      if (!issue) return t('draftInvalid')
      await tx.update(telegramConversations).set({
        issueId: issue.id,
        draftTitle: null,
        draftDescription: '',
        updatedAt: new Date(),
      }).where(eq(telegramConversations.threadId, conversation.threadId))
      return t('created', { issue: await issueLabel(tx, issue), title: issue.title })
    }
    case 'issues': {
      const visible = await findAccessibleIssues(tx, userId, workspaceId)
      if (!visible.length) return t('noTasks')
      const labels = await issueLabels(tx, visible)
      return visible.map(issue => t('issueLine', {
        issue: labels.get(issue.id)!,
        status: statusLabel(issue.status, t),
        title: issue.title,
      })).join('\n')
    }
    case 'link': {
      if (conversation.draftTitle) return t('finishDraft')
      const typed = command.args.trim()
      if (!typed || typed.length > 256 || /\s/u.test(typed)) return t('linkUsage')
      const id = uuidSchema.safeParse(typed)
      let issueId: string
      if (id.success) issueId = id.data
      else {
        // A historical spelling is a tenant-scoped hint, not permission or the
        // current display value. Shared tasks may have another creator.
        const resolved = await resolveTaskIdentifierAlias({ workspaceId, identifier: typed.toUpperCase() }, tx)
        if (resolved.kind === 'ambiguous') return t('ambiguous')
        if (resolved.kind === 'missing') return t('taskUnavailable')
        issueId = resolved.issueId
      }
      const issue = await linkAccessibleIssue(tx, userId, workspaceId, issueId, conversation.threadId)
      if (!issue) return t('taskUnavailable')
      return t('linked', { issue: await issueLabel(tx, issue), title: issue.title })
    }
    case 'status': {
      if (!conversation.issueId) return t('notLinked')
      const [issue] = await findAccessibleIssues(tx, userId, workspaceId, { id: conversation.issueId })
      if (!issue) {
        await tx.update(telegramConversations).set({ issueId: null, updatedAt: new Date() })
          .where(eq(telegramConversations.threadId, conversation.threadId))
        return t('linkedUnavailable')
      }
      return t('issueLine', {
        issue: await issueLabel(tx, issue),
        status: statusLabel(issue.status, t),
        title: issue.title,
      })
    }
    case 'unlink':
      if (!conversation.issueId) return t('unlinkNoTask')
      await tx.update(telegramConversations).set({ issueId: null, updatedAt: new Date() })
        .where(eq(telegramConversations.threadId, conversation.threadId))
      return t('unlinked')
    default:
      return t('unknownCommand')
  }
}

async function handleTelegramMessage(input: {
  threadId: string
  isDM: boolean
  author: Pick<Message['author'], 'isBot' | 'isMe' | 'userId' | 'userName'>
  raw: unknown
  messageId: number | null
  text: string
  post: (text: string) => Promise<unknown>
}) {
  if (!input.isDM || input.author.isBot || input.author.isMe || !input.author.userId) return
  const telegramUserId = input.author.userId
  const t = await getTranslations({ locale: localeOf(input.raw), namespace: 'TelegramBot' })
  const username = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '') ?? ''
  const command = parseTelegramCommand(input.text, username)
  if (command?.name === 'start') {
    if (!command.args) {
      const [existing] = await db.select({ userId: telegramLinks.userId }).from(telegramLinks)
        .where(eq(telegramLinks.telegramUserId, telegramUserId)).limit(1)
      await input.post(existing ? t('alreadyConnected') : t('connect'))
      return
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(command.args)) {
      await input.post(t('pairInvalid'))
      return
    }
    const result = await pairAccount({
      token: command.args,
      telegramUserId,
      telegramUserName: input.author.userName,
      threadId: input.threadId,
    })
    await input.post(result === 'linked' ? t('paired') : result === 'conflict' ? t('pairConflict') : t('pairInvalid'))
    return
  }

  const [link] = await db.select({ userId: telegramLinks.userId }).from(telegramLinks)
    .where(eq(telegramLinks.telegramUserId, telegramUserId)).limit(1)
  if (!link) {
    await input.post(t('connect'))
    return
  }
  // A Telegram message enters the person's Coordinator chat: its bot row is resolved here, before the transaction.
  // A Telegram link names a person and no workspace, so it is the personal workspace's Coordinator.
  const coordinator = await coordinatorBot(link.userId, null)
  const result = await withTaskWorkspace(link.userId, coordinator.workspaceId, () => db.transaction(async tx => {
    const conversation = await ensureConversation(tx, input.threadId, link.userId)
    if (command) return handleCommand(tx, conversation, link.userId, coordinator.workspaceId, command, t)
    const detail = input.text.trim()
    if (conversation.draftTitle) {
      if (!detail) return t('textDetailsRequired')
      const next = conversation.draftDescription ? conversation.draftDescription + '\n' + detail : detail
      if (next.length > MAX_DRAFT_DESCRIPTION) return t('draftTooLong')
      await tx.update(telegramConversations).set({ draftDescription: next, updatedAt: new Date() })
        .where(eq(telegramConversations.threadId, input.threadId))
      return t('detailsAdded')
    }
    if (!detail) return t('coordinatorMessageRequired')
    if (detail.length > 10_000) return t('coordinatorMessageTooLong')
    if (!await coordinatorEnabled(link.userId, coordinator.botId)) return t('coordinatorUnavailable')
    if (input.messageId === null) return t('messageUnavailable')
    await recordCoordinatorEvent(tx, userMessageEvent(link.userId, detail, {
      botId: coordinator.botId,
      issueId: conversation.issueId,
      telegram: { threadId: conversation.threadId, telegramUserId, messageId: input.messageId },
    }))
    // Telegram can resend a stored message. A fresh event registers the same
    // owner key; the commit observer delivers one wake in either case.
    wakeCoordinatorAfterCommit(tx, link.userId)
    return t('coordinatorQueued')
  }))
  await input.post(result)
}

export function handleTelegramDirectMessage(thread: Thread, message: Message) {
  return handleTelegramMessage({
    threadId: thread.id,
    isDM: thread.isDM,
    author: message.author,
    raw: message.raw,
    messageId: messageIdOf(message.raw),
    text: message.text,
    post: text => thread.post(text),
  })
}

export function handleTelegramSlashCommand(event: SlashCommandEvent) {
  const raw = event.raw as TelegramMessage | null
  return handleTelegramMessage({
    threadId: event.channel.id,
    isDM: raw?.chat.type === 'private',
    author: event.user,
    raw: event.raw,
    messageId: messageIdOf(raw),
    text: event.text ? event.command + ' ' + event.text : event.command,
    post: text => event.channel.post(text),
  })
}
