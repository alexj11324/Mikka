import { issueVisibility } from '@/lib/issue-visibility'
import 'server-only'

import { createHash } from 'node:crypto'
import { getTranslations } from 'next-intl/server'
import { and, desc, eq, gt, or, sql } from 'drizzle-orm'
import type { Message, SlashCommandEvent, Thread } from 'chat'
import type { TelegramMessage } from '@chat-adapter/telegram'
import { z } from 'zod'
import { db } from '@/lib/db'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { coordinatorBot } from '@/lib/coordinator/coordinator-bot'
import { userMessageEvent } from '@/lib/coordinator-events'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'
import { issueMembers, issues, linearIssueLinks, telegramConversations, telegramLinkTokens, telegramLinks } from '@/lib/db/schema'
import { createIssueForUserInTransaction } from '@/lib/issue-create'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { userActor } from '@/lib/activity-actor'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { taskIdentifiers, taskPrefixInput, type TaskPrefixInput } from '@/lib/task-identifier-server'
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

type LabelIssue = Pick<typeof issues.$inferSelect, 'id' | 'userId' | 'scope' | 'content'> & {
  /** A complete current lookup: null means there is no usable team identifier. */
  identifierTeam?: { key: string; number: number } | null
  /** Private naming input from this operation's bounded, authorized task read. */
  prefixInput?: TaskPrefixInput | null
}

async function issueLabels(tx: Transaction, rows: LabelIssue[]) {
  const knownTeams = rows.every(issue => issue.scope !== 'workspace' || issue.identifierTeam !== undefined)
    ? new Map(rows.flatMap(issue => issue.identifierTeam ? [[issue.id, issue.identifierTeam] as const] : [])) : undefined
  const identifiers = await taskIdentifiers(rows.map(issue => ({ id: issue.id, ownerId: issue.userId, scope: issue.scope, number: readIssueMetadata(issue.content).number, prefixInput: issue.prefixInput })), tx, knownTeams)
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

async function findAccessibleIssues(tx: Transaction, userId: string, workspaceId: string, match?: { id: string } | { identifier: string; number: number }) {
  const metadata = sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')`
  const condition = match && 'id' in match
    ? eq(issues.id, match.id)
    : match && 'identifier' in match
      // Narrowed here, then matched exactly against the shown identifier below.
      ? or(sql`${metadata}->>'number' = ${String(match.number)}`, sql`exists (select 1 from ${linearIssueLinks} where ${linearIssueLinks.issueId} = ${issues.id} and upper(${linearIssueLinks.linearIdentifier}) = ${match.identifier})`)
      : undefined
  const rows = await tx.select({ id: issues.id, userId: issues.userId, scope: issues.scope, title: issues.title, status: issues.status,
    content: issueAttrsContent, updatedAt: issues.updatedAt, prefixInput: taskPrefixInput(sql`issues."userId"`),
  }).from(issues)
    .leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
    .where(and(
      // Tenant authorization does not consume the global team-link list. The
      // bounded lookup below still rechecks linked-task membership and labels.
      (await issueVisibility(userId, false, workspaceId, tx, { withTeamLinks: false })).predicate,
      condition,
      sql`${metadata}->>'deletedAt' is null`,
    ))
    .orderBy(desc(issues.updatedAt))
    .limit(match ? 3 : 10)
  // Recheck exactly these candidates in one current workspace read. This
  // retains Telegram's linked-task permission check and also supplies labels.
  const scope = await numberedIssueTeamScope(userId, rows.map(issue => issue.id), { withWorkspaceMembership: true })
  const linked = new Set(scope.links.map(link => link.issueId))
  // This explicit mode preserves issueTeamAccess's workspace membership rule.
  const allowed = scope.workspaceMemberAllowed!
  return rows.flatMap(issue => isIssueTeamAccessAllowed({ linked: linked.has(issue.id), allowed: allowed.has(issue.id) })
    && !readIssueMetadata(issue.content).deletedAt
    ? [{ ...issue, identifierTeam: scope.taskTeams.get(issue.id) ?? null }] : [])
}

async function handleCommand(tx: Transaction, conversation: typeof telegramConversations.$inferSelect, userId: string, workspaceId: string, command: { name: string; args: string }, t: Translator): Promise<string | { reply: string; issueId: string }> {
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
      return { reply: t('created', { issue: await issueLabel(tx, issue), title: issue.title }), issueId: issue.id }
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
      const id = uuidSchema.safeParse(command.args)
      const typed = command.args.trim().toUpperCase()
      const number = typed.match(/^(?:[A-Z]+-|#)([1-9]\d*)$/)
      const issueNumber = number ? Number(number[1]) : null
      if (!id.success && (!issueNumber || !Number.isSafeInteger(issueNumber))) return t('linkUsage')
      const candidates = await findAccessibleIssues(tx, userId, workspaceId, id.success ? { id: id.data } : { identifier: typed, number: issueNumber! })
      const labels = await issueLabels(tx, candidates)
      const matches = id.success ? candidates : candidates.filter(issue => labels.get(issue.id)?.toUpperCase() === typed)
      if (!matches.length) return t('taskUnavailable')
      if (matches.length > 1) return t('ambiguous')
      const issue = matches[0]
      await tx.update(telegramConversations).set({ issueId: issue.id, updatedAt: new Date() })
        .where(eq(telegramConversations.threadId, conversation.threadId))
      return t('linked', { issue: labels.get(issue.id)!, title: issue.title })
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
    return { coordinator: true as const }
  }))
  if (typeof result !== 'string') {
    if ('coordinator' in result) {
      await wakeCoordinator(link.userId)
      await input.post(t('coordinatorQueued'))
      return
    }
    await input.post(result.reply)
    return
  }
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
