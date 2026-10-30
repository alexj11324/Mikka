import { FACTORY_QUESTION_INSTRUCTIONS } from '@/lib/factory/instructions'
import { FACTORY_CHECK_RECOVERY_INSTRUCTIONS } from '@/lib/factory/check-recovery'
import { issueMutationsEnabled } from '@/lib/coordinator/issue-tools-enabled'
import { FactoryError } from '@/lib/factory/contract'
import { preserveMessageSources } from '@/lib/coordinator/message-safety'
import { personalMailboxEnabled } from '@/lib/personal-mailbox-config'
import { personalMailboxInstructions } from '@/lib/personal-mailbox-instructions'
import { snapshotMailboxTools } from '@/lib/personal-mailbox-capability'
import type { MailboxToolRequest } from '@/lib/mailbox-tools'
import type { MailboxToolName } from '@mikka/protocol/mailbox'
import type { DefinitionSnapshot } from '@/lib/agent-kit/definition'
import { executionInstructions } from '@/lib/agent-kit/execution-instructions'
import type { AgentExecution } from '@/lib/agent-kit/store'
import { issueVisibility } from '@/lib/issue-visibility'
import { createHash } from 'node:crypto'
import { assertNativeToolScope, type NativeToolScope } from './tool-scope'
import type { ModelMessage } from 'ai'
import { summarizeConversation } from '@/lib/coordinator/summary-model'
import { and, asc, desc, eq } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { addRunMessage, queueRun, readRun, requestRunStop, visibleRuns } from '@/lib/agent-runs'
import { compactionCut, forgetNotes, instructionsWithMemory, promptMessages, rememberNote, SUMMARY_INSTRUCTIONS } from '@/lib/coordinator/context'
import { COORDINATOR_INSTRUCTIONS } from '@/lib/coordinator/instructions'
import { withPersonalInstructions } from '@/lib/coordinator/personal-instructions'
import { botInstructions } from '@/lib/coordinator/bot-instructions'
import * as store from '@/lib/coordinator/store'
import { db, pool } from '@/lib/db'
import { webSearch } from '@/lib/search'
import { issueMembers, issues } from '@/lib/db/schema'
import { COMPOSIO_ACTIONS, type ApprovalActionName, type ComposioActionName } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { proposeAction, proposeRepositoryPush } from '@/lib/pending-action-store'
import { issueForUser } from '@/lib/issue-access'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { tiptapToText } from '@/lib/tiptap-text'
import type { PendingTelegramTarget } from '@/lib/coordinator/telegram-pending'
import { createTelegramReplies } from '@/lib/coordinator/telegram-replies'
import { workspacePool } from '@/lib/workspace-db'
import { postTelegramText } from '@/lib/telegram/client'
import type { PushReason } from '@/lib/push-reasons'
import { queueCloudRun } from '@/lib/computer/queue-run'
import { ComputerStore } from '@/lib/computer/store'
import { bindBotSubscription } from '@/lib/computer/bot-subscription'
import { recordDecision, settleTurn } from '@/lib/attention/store'
import type { CreateIssueInput, UpdateIssueInput } from '@/lib/coordinator/issue-input'
import { systemActor } from '@/lib/activity-actor'

// Every function here is a durable step: it runs with full Node access, its
// result is recorded, and a failure is retried. Tools return `{ error }` for
// expected failures instead of throwing, so a bad id is not retried.

type ToolResult<T> = T | { error: string }

export async function computerToolsEnabled() {
  'use step'
  return process.env.MIKKA_CLOUD_COMPUTER_TASKS === '1' && process.env.MIKKA_BYOS_ENABLED === '1'
}

async function asToolResult<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof ActionFailureError || error instanceof FactoryError) return { error: error.code }
    throw error
  }
}

// `botId` picks the chat: null is the Coordinator, otherwise one of the person's bots.

export async function takeInbox(userId: string, holder: string, botId: string | null = null) {
  'use step'
  return store.takeInbox(userId, holder, botId)
}

/** Settles the matters a turn was handed but did not decide on, and hands over the next one. */
export async function settleAttention(userId: string, matterIds: string[], toldPerson: boolean) {
  'use step'
  await settleTurn(userId, matterIds, toldPerson)
}

export async function recordAttention(userId: string, input: { matterId: string; decision: 'notify' | 'quiet' | 'snooze' | 'handled'; reason?: string; runAt?: string; personAsked?: boolean }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  const reason = input.reason?.trim()
  switch (input.decision) {
    case 'quiet':
      return reason ? recordDecision(userId, { matterId: input.matterId, decision: 'quiet', reason }) : { error: 'reasonRequired' }
    case 'snooze':
      if (!reason) return { error: 'reasonRequired' }
      if (!input.runAt) return { error: 'runAtRequired' }
      return recordDecision(userId, { matterId: input.matterId, decision: 'snooze', reason, runAt: new Date(input.runAt), personAsked: input.personAsked })
    default:
      return recordDecision(userId, { matterId: input.matterId, decision: input.decision, reason })
  }
}

export async function releaseLease(userId: string, holder: string, botId: string | null = null) {
  'use step'
  return store.releaseLease(userId, holder, botId)
}

export async function failTurn(userId: string, holder: string, error: string, botId: string | null = null) {
  'use step'
  await store.failTurn(userId, holder, error, botId)
}

export async function appendMessages(userId: string, holder: string, messages: ModelMessage[], warning: string | null = null, botId: string | null = null) {
  'use step'
  await store.appendMessages(userId, holder, messages, warning, botId)
}

/** Every chunk revalidates its source, owner, chat lease and current Telegram
 * link. A cached earlier step cannot turn a revoked link into send authority.
 * Telegram has no idempotency key: response loss can remain externally uncertain. */
export async function sendTelegramChunk(userId: string, botId: string | null, holder: string, target: PendingTelegramTarget, chunk: string) {
  'use step'
  await createTelegramReplies(pool, workspacePool).send(userId, botId, holder, target, tx => postTelegramText(target.threadId, chunk, tx))
}

export async function acknowledgeTelegramReply(userId: string, botId: string | null, holder: string, target: PendingTelegramTarget) {
  'use step'
  await createTelegramReplies(pool, workspacePool).acknowledge(userId, botId, holder, target)
}

/** Pushes a reply the Coordinator raised on its own to the person's phones, as their 通知 settings allow (lib/mobile-push.ts). */
export async function pushToPhones(userId: string, botId: string | null, text: string | null, reasons: PushReason[]) {
  'use step'
  // Loaded here, not at the top: only this step needs the push sender and its settings.
  const { pushReply } = await import('@/lib/mobile-push')
  await pushReply(userId, botId, text, reasons)
}

/**
 * Folds older messages into the summary once the conversation passes the
 * token budget, then returns the prompt for this turn: the instructions with
 * the person's memory, and the messages.
 */
export async function preparePrompt(userId: string, botId: string | null = null, snapshot?: DefinitionSnapshot, mailboxTools: readonly MailboxToolName[] = []): Promise<{ instructions: string; messages: ModelMessage[] }> {
  'use step'
  // Fallback only: run completion already reconciles (lib/run-completion-effects.ts
  // reconcileFactoryAfterCompletion). This catches completions whose hook failed.
  if (process.env.MIKKA_FACTORY_ROUTING_ENABLED === '1' && process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED === '1') {
    const { factoryRuntimeForBot } = await import('@/lib/factory/runtime')
    await factoryRuntimeForBot(botId).reconcile(userId)
  }

  let { summary, memory, messages } = await store.loadConversation(userId, botId)
  const summaryTrust = { key: process.env.BETTER_AUTH_SECRET ?? '', scope: JSON.stringify([userId, botId]) }
  const cut = compactionCut(summary, messages, summaryTrust)
  if (cut !== null) {
    if (summaryTrust.key.length < 32) throw new Error('Existing host auth secret required for summary provenance')
    const folded = messages.filter(row => row.position <= cut)
    const messagesToCompact: ModelMessage[] = [...promptMessages(summary, folded, summaryTrust), { role: 'user', content: 'Write the summary now.' }]
    const hasImages = messagesToCompact.some(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(part => part.type === 'image' || (part.type === 'file' && part.mediaType.startsWith('image/'))))
    if (hasImages && !snapshot) throw new Error('compactionModelUnavailable')
    const { text } = await summarizeConversation(userId, botId, snapshot, {
      instructions: SUMMARY_INSTRUCTIONS,
      maxOutputTokens: 4096,
      messages: messagesToCompact,
    })
    summary = preserveMessageSources(text, folded, summary, summaryTrust)
    await store.saveSummary(userId, summary, cut, botId)
    messages = messages.filter(row => row.position > cut)
  }
  const base = snapshot ? executionInstructions(snapshot) : await botInstructions(userId, botId, COORDINATOR_INSTRUCTIONS)
  const instructions = personalMailboxEnabled() && snapshot ? personalMailboxInstructions(base, snapshotMailboxTools(snapshot).filter(name => mailboxTools.includes(name))) : base
  const factoryPolicy = process.env.MIKKA_FACTORY_ROUTING_ENABLED === '1' && process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED === '1' ? FACTORY_QUESTION_INSTRUCTIONS + FACTORY_CHECK_RECOVERY_INSTRUCTIONS : ''
  // The person's 个人指令 sit after the rules and before the memory, marked as theirs.
  return { instructions: instructionsWithMemory(await withPersonalInstructions(userId, instructions), memory) + factoryPolicy, messages: promptMessages(summary, messages, summaryTrust) }
}

export async function personalWriteToolsEnabled() { 'use step'; const { personalWritesEnabled } = await import('@/lib/operations/write-feature'); return personalWritesEnabled() }

export async function mailboxToolsEnabled() { 'use step'; return personalMailboxEnabled() }
export async function mailboxCatalogue(userId: string, botId: string | null, executionId?: string) {
  'use step'
  if (!personalMailboxEnabled()) return []
  const { personalConversationMailboxAdvertised } = await import('@/lib/personal-mailbox-runtime')
  return personalConversationMailboxAdvertised(userId, botId, executionId)
}
export async function personalMailbox(userId: string, botId: string | null, request: MailboxToolRequest, scope?: NativeToolScope, executionId?: string) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (!personalMailboxEnabled()) return { error: 'personal_mailbox_unavailable' }
  const { personalConversationMailbox } = await import('@/lib/personal-mailbox-runtime')
  const result = await personalConversationMailbox(userId, botId, request, scope, executionId)
  return result.body
}

export async function remember(userId: string, input: { note: string }, scope?: NativeToolScope, botId: string | null = null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return store.editMemory(userId, memory => {
    const next = rememberNote(memory, input.note)
    return next === null ? { error: 'memoryFull: forget something first' } : { memory: next, result: { remembered: true } }
  }, botId)
}

export async function forget(userId: string, input: { text: string }, scope?: NativeToolScope, botId: string | null = null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return store.editMemory(userId, memory => {
    const { memory: next, removed } = forgetNotes(memory, input.text)
    return { memory: next, result: { removed } }
  }, botId)
}

/** 团队权限 › 允许使用的应用: a workspace can block an app for its bots. The personal Coordinator (no botId) is not governed. */
async function appBlockedForBot(botId: string | null | undefined, action: ComposioActionName) {
  if (!botId) return false
  const { botMayUseApp } = await import('@/lib/app-policy/store')
  const { isPolicyApp } = await import('@/lib/app-policy/apps')
  const toolkit = COMPOSIO_ACTIONS[action]?.toolkit
  return Boolean(toolkit && isPolicyApp(toolkit) && !(await botMayUseApp(botId, toolkit)))
}

export async function composioAction(userId: string, action: ComposioActionName, input: unknown, scope?: NativeToolScope, accountId?: string, botId?: string | null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  if (await appBlockedForBot(botId, action)) return { error: 'integrationBlockedByWorkspace' }
  return accountId ? runComposioAction(userId, action, input, accountId) : runComposioAction(userId, action, input)
}

export async function proposeAccountAction(userId: string, action: ApprovalActionName, input: unknown, scope?: NativeToolScope, accountId?: string, botId?: string | null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  if (await appBlockedForBot(botId, action)) return { error: 'integrationBlockedByWorkspace' }
  return accountId ? proposeAction(userId, action, input, accountId) : proposeAction(userId, action, input)
}

export async function proposeRepositoryPushApproval(userId: string, input: { repo: string }, scope?: NativeToolScope, task?: { eventId: string; botId: string | null }) {
  'use step'
  await assertNativeToolScope(userId, scope)
  return proposeRepositoryPush(userId, input, task)
}

export async function listIssues(userId: string, input: { status?: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  const rows = await db.selectDistinct({ id: issues.id, title: issues.title, status: issues.status, priority: issues.priority, content: issues.content, updatedAt: issues.updatedAt })
    .from(issues).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
    .where(and((await issueVisibility(userId)).predicate, input.status ? eq(issues.status, input.status) : undefined))
    .orderBy(desc(issues.updatedAt)).limit(100)
  return rows.filter(row => !readIssueMetadata(row.content).deletedAt).slice(0, 50).map(({ content, updatedAt, ...row }) => ({
    ...row, number: readIssueMetadata(content).number ?? null, updatedAt: updatedAt.toISOString(),
  }))
}

export async function getIssue(userId: string, input: { issueId: string }, scope?: NativeToolScope, botId: string | null = null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  const issue = await issueForUser(userId, input.issueId)
  if (!issue) return { error: 'issueNotFound' }
  const runs = await visibleRuns(userId, { issueId: issue.id, limit: 5 })
  return {
    id: issue.id, number: readIssueMetadata(issue.content).number ?? null, title: issue.title,
    status: issue.status, priority: issue.priority, body: tiptapToText(issue.content).slice(0, 8000),
    runs: runs.map(run => ({ id: run.id, agent: run.agentName, status: run.status, createdAt: run.createdAt.toISOString() })),
    ...(process.env.MIKKA_FACTORY_ROUTING_ENABLED === '1' ? { factory: await (await import('@/lib/factory/server')).factoryForBot(botId).listForIssue(userId,issue.id) } : {}),
  }
}

export async function createIssue(userId: string, input: CreateIssueInput, toolCallId: string, scope?: NativeToolScope, botId: string | null = null, taskEventId?: string) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (!toolCallId || toolCallId.length > 200) return { error: 'issueToolCallConflict' }
  return (await import('@/lib/mcp/actions')).createIssue(userId, input, systemActor(botId ?? 'coordinator'), toolCallId, taskEventId ? { eventId: taskEventId, botId } : undefined)
}

export async function updateIssue(userId: string, input: UpdateIssueInput, toolCallId: string, scope?: NativeToolScope, botId: string | null = null) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (!toolCallId || toolCallId.length > 200) return { error: 'issueToolCallConflict' }
  return (await import('@/lib/mcp/actions')).updateIssue(userId, input, systemActor(botId ?? 'coordinator'), toolCallId)
}

export async function listAgents(userId: string, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return (await import('@/lib/mcp/actions')).listAgents(userId)
}

/** The run belongs to the bot that dispatched it, so its events come back to that bot's chat. */
export async function dispatchRun(userId: string, input: { issueId: string; agentId: string; repo: string; note?: string }, scope?: NativeToolScope, botId: string | null = null, execution?: AgentExecution, requestEventId?: string, approvedRepositoryKey?: string) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async () => ({ ...(await queueRun(userId, input, botId, execution, requestEventId, null, approvedRepositoryKey)), status: 'queued' }))
}

/** Only the person's own Bots in workspaces they still belong to are listed. */
export async function listComputerWorkspaces(userId: string, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1' || process.env.MIKKA_BYOS_ENABLED !== '1') return { error: 'cloudComputerUnavailable' }
  const [{ workspaceDb }, { workspaces, workspaceMembers }] = await Promise.all([import('@/lib/workspace-db'), import('@/lib/db/workspace-schema')])
  return workspaceDb.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'))).orderBy(asc(workspaces.createdAt)).limit(50)
}

/** The tool call id makes a retried Bot creation idempotent. */
export async function createComputerBot(userId: string, input: { workspaceId: string; name: string }, toolCallId: string, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1' || process.env.MIKKA_BYOS_ENABLED !== '1' || !toolCallId || toolCallId.length > 200) return { error: 'cloudComputerUnavailable' }
  try {
    await (await import('@/lib/subscription-runtime')).authorizeSubscriptionWorkspace(userId, input.workspaceId)
    const hash = createHash('sha256').update(JSON.stringify(['create-bot', userId, toolCallId])).digest('hex')
    const botId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
    await pool.query('INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING', [botId, input.workspaceId, userId, input.name])
    const found = await pool.query('SELECT id,name FROM bots WHERE id=$1 AND "workspaceId"=$2 AND "ownerId"=$3 AND name=$4', [botId, input.workspaceId, userId, input.name])
    return found.rows[0] ?? { error: 'cloudComputerUnavailable' }
  } catch { return { error: 'cloudComputerUnavailable' } }
}

export async function listComputerBots(userId: string, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1' || process.env.MIKKA_BYOS_ENABLED !== '1') return { error: 'cloudComputerUnavailable' }
  const { authorizeSubscriptionWorkspace } = await import('@/lib/subscription-runtime')
  const { rows } = await pool.query(`SELECT b.id,b.name,b."workspaceId",coalesce(array_agg(r.harness) FILTER (WHERE r.harness IS NOT NULL),'{}') AS harnesses
    FROM bots b LEFT JOIN bot_cloud_runtimes r ON r."botId"=b.id AND r."ownerId"=b."ownerId" AND r."workspaceId"=b."workspaceId"
    WHERE b."ownerId"=$1 GROUP BY b.id ORDER BY b."createdAt",b.id LIMIT 50`, [userId])
  const visible = await Promise.all(rows.map(async row => {
    try { await authorizeSubscriptionWorkspace(userId, row.workspaceId); return { id: row.id, name: row.name, harnesses: row.harnesses } }
    catch { return null }
  }))
  return visible.filter(item => item !== null)
}

/** Queue and bind atomically, with a stable tool-call id for workflow retries. */
export async function dispatchComputerTask(userId: string, input: { botId: string; issueId: string; harness: 'codex' | 'claude_code'; note?: string; suggestionId?: string }, toolCallId: string, scope?: NativeToolScope, execution?: AgentExecution) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1' || process.env.MIKKA_BYOS_ENABLED !== '1' || !toolCallId || toolCallId.length > 200) return { error: 'cloudComputerUnavailable' }
  const target = (await pool.query(`SELECT b."workspaceId",r."agentId",r."repoId" FROM bots b
    JOIN bot_cloud_runtimes r ON r."botId"=b.id AND r."ownerId"=b."ownerId" AND r."workspaceId"=b."workspaceId"
    WHERE b.id=$1 AND b."ownerId"=$2 AND r.harness=$3`, [input.botId, userId, input.harness])).rows[0]
  if (!target) return { error: 'cloudComputerUnavailable' }
  try { await (await import('@/lib/subscription-runtime')).authorizeSubscriptionWorkspace(userId, target.workspaceId) } catch { return { error: 'cloudComputerUnavailable' } }
  const issue = await issueForUser(userId, input.issueId)
  if (!issue) return { error: 'issueNotFound' }
  try {
    if (input.suggestionId && !(await pool.query('SELECT 1 FROM suggestion_executions WHERE "suggestionId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND ("botId" IS NULL OR "botId"=$4)', [input.suggestionId, userId, target.workspaceId, input.botId])).rowCount) return { error: 'suggestionUnavailable' }
    const result = await queueCloudRun(pool, { userId, workspaceId: target.workspaceId }, { botId: input.botId, issueId: issue.id, agentId: target.agentId, deviceRepoId: target.repoId, title: issue.title, body: tiptapToText(issue.content), note: input.note, idempotencyKey: input.suggestionId ? `suggestion:${input.suggestionId}` : `coordinator:${toolCallId}`, execution })
    if (input.suggestionId) await pool.query('UPDATE suggestion_executions SET "botId"=$4,"runId"=$5,status=\'running\' WHERE "suggestionId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND ("runId" IS NULL OR "runId"=$5)', [input.suggestionId, userId, target.workspaceId, input.botId, result.runId])
    if (process.env.MIKKA_CLOUD_THREAD_MACHINES === '1') {
      const actor = { userId, workspaceId: target.workspaceId as string }
      await (await import('@/lib/cloud-computer/thread-machines')).ensureThreadMachine(pool, actor, result.runId)
      const { start } = await import('workflow/api')
      const { threadMachineLifecycle } = await import('@/workflows/thread-machine/workflow')
      await start(threadMachineLifecycle, [actor, result.runId])
    }
    return { ...result, botId: input.botId, task: issue.title, status: 'queued' as const }
  } catch { return { error: 'cloudComputerUnavailable' } }
}

/** Start only an owned Bot's computer after workspace authorization. */
export async function wakeComputerBot(userId: string, input: { botId: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1' || process.env.MIKKA_BYOS_ENABLED !== '1') return { error: 'cloudComputerUnavailable' }
  const bot = (await pool.query('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2', [input.botId, userId])).rows[0]
  if (!bot) return { error: 'cloudComputerUnavailable' }
  try {
    await (await import('@/lib/subscription-runtime')).authorizeSubscriptionWorkspace(userId, bot.workspaceId)
    const actor = { userId, workspaceId: bot.workspaceId as string }
    await new ComputerStore(pool).operate(actor, input.botId, 'wake')
    await (await import('@/lib/computer/wake-worker')).ensureCloudBotWorker(pool, actor, input.botId)
    // Worker installation is not evidence that any model credential is bound
    // or that a hosted task can execute. Check that separately before claiming it.
    return { botId: input.botId, awake: true, taskReadiness: 'not_checked', taskRequirement: 'A connected and bound subscription is required before running a hosted task.' }
  } catch { return { error: 'cloudComputerUnavailable' } }
}

export async function listBotSubscriptions(userId: string, input: { botId: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1' || process.env.MIKKA_BYOS_ENABLED !== '1') return { error: 'cloudComputerUnavailable' }
  const bot = (await pool.query('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2', [input.botId, userId])).rows[0]
  if (!bot) return { error: 'cloudComputerUnavailable' }
  try { await (await import('@/lib/subscription-runtime')).authorizeSubscriptionWorkspace(userId, bot.workspaceId) } catch { return { error: 'cloudComputerUnavailable' } }
  const rows = (await pool.query(`SELECT id,provider,epoch FROM byos_connections WHERE "ownerId"=$1 AND "workspaceId"=$2 AND state='connected' ORDER BY "createdAt",id LIMIT 50`, [userId, bot.workspaceId])).rows
  return rows.map(row => ({ connectionId: row.id, provider: row.provider, revision: Number(row.epoch) }))
}

export async function bindComputerSubscription(userId: string, input: { botId: string; connectionId: string; revision: number; harness: 'codex' | 'claude_code'; modelId: string }, toolCallId: string, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1' || process.env.MIKKA_BYOS_ENABLED !== '1' || !toolCallId || toolCallId.length > 200) return { error: 'cloudComputerUnavailable' }
  const bot = (await pool.query('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2', [input.botId, userId])).rows[0]
  if (!bot) return { error: 'cloudComputerUnavailable' }
  try {
    await (await import('@/lib/subscription-runtime')).authorizeSubscriptionWorkspace(userId, bot.workspaceId)
    await bindBotSubscription(pool, { userId, workspaceId: bot.workspaceId }, { ...input, idempotencyKey: `coordinator:${toolCallId}` })
    return { botId: input.botId, bound: true }
  } catch { return { error: 'subscriptionUnavailable' } }
}

export async function listRuns(userId: string, input: { issueId?: string; activeOnly?: boolean }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  const rows = await visibleRuns(userId, input)
  return rows.map(run => ({ id: run.id, issueId: run.issueId, agent: run.agentName, status: run.status, stopReason: run.stopReason, createdAt: run.createdAt.toISOString() }))
}

export async function getRun(userId: string, input: { runId: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  const detail = await readRun(userId, input.runId)
  if (!detail) return { error: 'runNotFound' }
  const { run } = detail
  return {
    id: run.id, issueId: run.issueId, agent: run.agentName, harness: run.harness, status: run.status,
    stopReason: run.stopReason, error: run.error, summary: (run.report as { summary?: string } | null)?.summary ?? null,
    sourceCommit: run.report?.sourceCommit ?? null,
    skillMount: run.report?.skillMount ?? null,
    runtime: run.report?.runtime ?? null,
    verify: run.report?.verify ?? null,
    startedAt: run.startedAt?.toISOString() ?? null, finishedAt: run.finishedAt?.toISOString() ?? null,
    // The tail of the event stream, enough to see what the agent is doing.
    recentEvents: detail.chunks.slice(-5).map(chunk => JSON.stringify(chunk).slice(0, 1000)),
  }
}

export async function sendToRun(userId: string, input: { runId: string; text: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async () => { await addRunMessage(userId, input, 'peer'); return { sent: true } })
}

export async function stopRun(userId: string, input: { runId: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async () => { await requestRunStop(userId, input.runId); return { stopRequested: true } })
}

/** Web search through the shared SearchProvider (MIK-5); degrades to searchUnavailable on 429/5xx/timeout. */
export async function webSearchStep(userId: string, input: { query: string; limit?: number }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return webSearch(input.query, { userId, caller: 'coordinator' }, { limit: input.limit })
}

/** Web work stays in the Bot chat; it never creates an agent_runs row. */
export async function startWebSubagent(userId: string, input: { botId: string; task: string; suggestionId?: string }, toolCallId: string, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (!toolCallId || toolCallId.length > 200) return { error: 'browserUnavailable' }
  const bot = (await pool.query('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2', [input.botId, userId])).rows[0]
  if (!bot) return { error: 'botUnavailable' }
  await (await import('@/lib/subscription-runtime')).authorizeSubscriptionWorkspace(userId, bot.workspaceId)
  const { SubagentStore } = await import('@/lib/cloud-computer/subagents')
  const { start } = await import('workflow/api')
  const { webSubagentWorkflow } = await import('@/workflows/subagent/workflow')
  const digest = createHash('sha256').update(JSON.stringify(input.suggestionId ? ['suggestion-web', userId, input.suggestionId] : ['web-subagent', userId, input.botId, toolCallId])).digest('hex')
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  const actor = { userId, workspaceId: bot.workspaceId as string }
  if (input.suggestionId) {
    const suggestion = await pool.query('SELECT 1 FROM suggestion_executions WHERE "suggestionId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND ("botId" IS NULL OR "botId"=$4)', [input.suggestionId, userId, actor.workspaceId, input.botId])
    if (!suggestion.rowCount) return { error: 'suggestionUnavailable' }
  }
  const row = await new SubagentStore(pool).create(actor, input.botId, input.task, id)
  if (input.suggestionId) await pool.query(`UPDATE suggestion_executions SET status='running',"subagentId"=$5,"botId"=$4 WHERE "suggestionId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND ("botId" IS NULL OR "botId"=$4) AND ("subagentId" IS NULL OR "subagentId"=$5)`, [input.suggestionId, userId, actor.workspaceId, input.botId, id])
  await start(webSubagentWorkflow, [actor, input.botId, row.id])
  return { subagentId: row.id, state: row.status, botId: input.botId }
}

/** Host-owned identity and native fence are not model arguments. */
export async function personalWrite(userId:string, botId:string | null, executionId:string, call:import('@/lib/operations/model-write-tools').ModelWriteCall, scope?:NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  const { WRITE_TOOL_APPS } = await import('@/lib/app-policy/apps')
  const app = WRITE_TOOL_APPS[call.action]
  if (botId && app) {
    const { botMayUseApp } = await import('@/lib/app-policy/store')
    if (!(await botMayUseApp(botId, app))) return { error: 'integrationBlockedByWorkspace' }
  }
  const { personalWriteFromRun } = await import('@/lib/operations/write-runtime')
  return personalWriteFromRun(userId,botId,executionId,call,scope)
}
/** Durable personal intake; existing issue receipts recover a crash before routing. */
export async function intakeFactoryRequest(userId: string, input: import('@/lib/factory/intake').IntakeInput, scope?: NativeToolScope, botId: string | null = null) {
  'use step'
  await assertNativeToolScope(userId, scope)
  return asToolResult(async () => {
    const { factoryForBot, factoryRequestSource } = await import('@/lib/factory/server')
    const { intakeRequest } = await import('@/lib/factory/intake')
    const store=factoryForBot(botId)
    return intakeRequest(input, {
      source:id=>factoryRequestSource(userId,botId,id),
      create:async(body,key)=>(await import('@/lib/mcp/actions')).createIssue(userId,body,systemActor(botId ?? 'coordinator'),key),
      route:route=>store.route(userId,route),
    })
  })
}
export async function listFactoryRequestsScoped(userId:string,scope?:NativeToolScope,botId:string|null=null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async()=> (await import('@/lib/factory/server')).factoryRequestSource(userId,botId))
}
export async function readFactoryTask(userId:string,taskId:string,scope?:NativeToolScope,botId:string|null=null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async()=> (await import('@/lib/factory/server')).factoryForBot(botId).read(userId,taskId))
}
export async function resolveFactoryTaskScoped(userId:string,input: import('@/lib/factory/intake').ResolveInput,scope?:NativeToolScope,botId:string|null=null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async()=> (await import('@/lib/factory/server')).factoryForBot(botId).apply(userId,input.binding,input.eventId,input.change))
}

export async function stopFactoryTaskScoped(userId:string,input:import('@/lib/factory/intake').StopInput,scope?:NativeToolScope,botId:string|null=null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async()=> (await import('@/lib/factory/server')).factoryForBot(botId).apply(userId,input.binding,input.eventId,{action:input.action,reason:input.reason}))
}

export async function dispatchFactoryTask(userId:string,input:import('@/lib/factory/dispatch').FactoryDispatchInput,scope?:NativeToolScope,botId:string|null=null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async()=> (await import('@/lib/factory/runtime')).factoryRuntimeForBot(botId).dispatch(userId,input))
}
export async function recoverFactoryCheck(userId:string,input:import('@/lib/factory/check-recovery').FactoryCheckRecoveryInput,sdkToolCallId:string,scope?:NativeToolScope,botId:string|null=null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  if (!issueMutationsEnabled()) return {error:'issue_mutations_unavailable'}
  return asToolResult(async()=> (await import('@/lib/factory/runtime')).factoryRuntimeForBot(botId).recoverCheck(userId,input,sdkToolCallId))
}
export async function listFactoryQuestionsScoped(userId:string,taskId:string,scope?:NativeToolScope,botId:string|null=null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async()=> (await import('@/lib/factory/runtime')).factoryRuntimeForBot(botId).questions.list(userId,taskId))
}
export async function answerFactoryContextScoped(userId:string,input:import('@/lib/factory/questions/contract').ContextQuestionAnswer,scope?:NativeToolScope,botId:string|null=null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async()=> (await import('@/lib/factory/runtime')).factoryRuntimeForBot(botId).questions.answer({source:'orchestrator',userId},input))
}
export async function escalateFactoryQuestionScoped(userId:string,input:import('zod').z.infer<typeof import('@/lib/factory/questions/contract').questionEscalationSchema>,scope?:NativeToolScope,botId:string|null=null) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async()=> (await import('@/lib/factory/runtime')).factoryRuntimeForBot(botId).questions.escalate(userId,input))
}
export { listFactoryRequests, resolveFactoryTask, stopFactoryTask, listFactoryQuestions, answerFactoryContext, escalateFactoryQuestion, dispatchRun as dispatchFactoryRunStep, selectBaselineSkill, selectActiveSkill, registerSkillCandidate, skillEvaluation, dispatchBaselineRehearsal, recordRunFeedback, proposeSkillImprovement, readRunImprovements, handoffSkillImprovement, getSkillImprovementFactory, createIssueFromRequestStep, routeFactoryTask, getFactoryTask, getFactoryQuestion, answerFactoryQuestionFromUser } from './factory-steps'
