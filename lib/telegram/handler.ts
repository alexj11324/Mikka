import { issueVisibility } from '@/lib/issue-visibility'
import 'server-only'

import { createHash } from 'node:crypto'
import { getTranslations } from 'next-intl/server'
import { and, desc, eq, gt, or, sql } from 'drizzle-orm'
import type { Message, SlashCommandEvent, Thread } from 'chat'
import type { TelegramMessage } from '@chat-adapter/telegram'
import { z } from 'zod'
import { db } from '@/lib/db'
import { issueMembers, issues, linearIssueLinks, telegramConversations, telegramLinkTokens, telegramLinks } from '@/lib/db/schema'
import { createIssueForUserInTransaction } from '@/lib/issue-create'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { issueTeamAccess } from '@/lib/issue-team-access'
import { isIssueTeamAccessAllowed } from '@/lib/issue-team-access-policy'
import { dispatchLinearIssueSync } from '@/lib/linear-sync/dispatch'
import { judgeIssueScope } from '@/lib/issue-scope-judge'
import { after } from 'next/server'
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

async function issueLabels(tx: Transaction, rows: (typeof issues.$inferSelect)[]) {
  const identifiers = await taskIdentifiers(rows.map(issue => ({ id: issue.id, ownerId: issue.userId, scope: issue.scope, number: readIssueMetadata(issue.content).number })), tx)
  return new Map(rows.map(issue => [issue.id, identifiers.get(issue.id) ?? issue.id]))
}

async function issueLabel(tx: Transaction, issue: typeof issues.$inferSelect) {
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

async function findAccessibleIssues(tx: Transaction, userId: string, match?: { id: string } | { identifier: string; number: number }) {
  const metadata = sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')`
  const condition = match && 'id' in match
    ? eq(issues.id, match.id)
    : match && 'identifier' in match
      // Narrowed here, then matched exactly against the shown identifier below.
      ? or(sql`${metadata}->>'number' = ${String(match.number)}`, sql`exists (select 1 from ${linearIssueLinks} where ${linearIssueLinks.issueId} = ${issues.id} and upper(${linearIssueLinks.linearIdentifier}) = ${match.identifier})`)
      : undefined
  const rows = await tx.select({ issue: issues }).from(issues)
    .leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
    .where(and(
      (await issueVisibility(userId)).predicate,
      condition,
      sql`${metadata}->>'deletedAt' is null`,
    ))
    .orderBy(desc(issues.updatedAt))
    .limit(match ? 3 : 10)
  const accessible = await Promise.all(rows.map(async ({ issue }) =>
    isIssueTeamAccessAllowed(await issueTeamAccess(issue.id, userId)) ? issue : null,
  ))
  return accessible.filter((issue): issue is typeof issues.$inferSelect =>
    issue !== null && !readIssueMetadata(issue.content).deletedAt,
  )
}

async function handleCommand(tx: Transaction, conversation: typeof telegramConversations.$inferSelect, userId: string, command: { name: string; args: string }, t: Translator): Promise<string | { reply: string; issueId: string }> {
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
      })
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
      const visible = await findAccessibleIssues(tx, userId)
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
      const candidates = await findAccessibleIssues(tx, userId, id.success ? { id: id.data } : { identifier: typed, number: issueNumber! })
      const labels = await issueLabels(tx, candidates)
      const matches = id.success ? candidates : candidates.filter(issue => labels.get(issue.id)?.toUpperCase() === typed)
      if (!matches.length) return t('taskUnavailable')
      if (matches.length > 1) return t('ambiguous')
      const issue = matches[0]
      await tx.update(telegramConversations).set({ issueId: issue.id, updatedAt: new Date() })
        .where(eq(telegramConversations.threadId, conversation.threadId))
      return t('linked', { issue: await issueLabel(tx, issue), title: issue.title })
    }
    case 'status': {
      if (!conversation.issueId) return t('notLinked')
      const [issue] = await findAccessibleIssues(tx, userId, { id: conversation.issueId })
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
  text: string
  post: (text: string) => Promise<unknown>
}) {
  if (!input.isDM || input.author.isBot || input.author.isMe || !input.author.userId) return
  const t = await getTranslations({ locale: localeOf(input.raw), namespace: 'TelegramBot' })
  const username = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '') ?? ''
  const command = parseTelegramCommand(input.text, username)
  if (command?.name === 'start') {
    if (!command.args) {
      const [existing] = await db.select({ userId: telegramLinks.userId }).from(telegramLinks)
        .where(eq(telegramLinks.telegramUserId, input.author.userId)).limit(1)
      await input.post(existing ? t('alreadyConnected') : t('connect'))
      return
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(command.args)) {
      await input.post(t('pairInvalid'))
      return
    }
    const result = await pairAccount({
      token: command.args,
      telegramUserId: input.author.userId,
      telegramUserName: input.author.userName,
      threadId: input.threadId,
    })
    await input.post(result === 'linked' ? t('paired') : result === 'conflict' ? t('pairConflict') : t('pairInvalid'))
    return
  }

  const [link] = await db.select({ userId: telegramLinks.userId }).from(telegramLinks)
    .where(eq(telegramLinks.telegramUserId, input.author.userId)).limit(1)
  if (!link) {
    await input.post(t('connect'))
    return
  }
  const result = await db.transaction(async tx => {
    const conversation = await ensureConversation(tx, input.threadId, link.userId)
    if (command) return handleCommand(tx, conversation, link.userId, command, t)
    if (!conversation.draftTitle) return conversation.issueId ? t('linkedChat') : t('startDraftMessage')
    const detail = input.text.trim()
    if (!detail) return t('textDetailsRequired')
    const next = conversation.draftDescription ? conversation.draftDescription + '\n' + detail : detail
    if (next.length > MAX_DRAFT_DESCRIPTION) return t('draftTooLong')
    await tx.update(telegramConversations).set({ draftDescription: next, updatedAt: new Date() })
      .where(eq(telegramConversations.threadId, input.threadId))
    return t('detailsAdded')
  })
  if (typeof result !== 'string') {
    dispatchLinearIssueSync(result.issueId)
    after(() => judgeIssueScope(result.issueId, 'Telegram'))
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
    text: event.text ? event.command + ' ' + event.text : event.command,
    post: text => event.channel.post(text),
  })
}
