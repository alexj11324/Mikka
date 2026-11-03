import { queueTaskRun } from '@/lib/factory/queue-local'
import { deploymentSwitch } from '@/lib/deployment-switches'
import { cloudComputerRunsEnabled } from '@/lib/cloud-computer-flag'
import { runInvalidDetail } from '@/lib/run-invalid-reason'
import { FatalError } from 'workflow'
import type { CoordinatorWorkflowStreamPart } from '@/lib/coordinator/stream'
import { SCHEDULE_INSTRUCTIONS } from '@/lib/schedules/contract'
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
import { addRunMessage,  readRun, requestRunStop, visibleRuns } from '@/lib/agent-runs'
import { compactionCut, forgetNotes, cachedContextLines, promptMessages, promptWithCachedContext, rememberNote, SUMMARY_INSTRUCTIONS } from '@/lib/coordinator/context'
import { COORDINATOR_INSTRUCTIONS } from '@/lib/coordinator/instructions'
import { withPersonalInstructions } from '@/lib/coordinator/personal-instructions'
import { botInstructions } from '@/lib/coordinator/bot-instructions'
import { withCoordinatorPresentation } from '@/lib/coordinator/native-prompt'
import * as store from '@/lib/coordinator/store'
import { db, pool } from '@/lib/db'
import { webSearch } from '@/lib/search'
import { issueMembers, issues } from '@/lib/db/schema'
import { type ApprovalActionName, type ComposioActionName } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { writeAccountAction } from '@/lib/pending-action-store'
import { issueForUser } from '@/lib/issue-access'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { tiptapToText } from '@/lib/tiptap-text'
import type { PendingTelegramTarget } from '@/lib/coordinator/telegram-pending'
import { createTelegramReplies } from '@/lib/coordinator/telegram-replies'
import { workspacePool } from '@/lib/workspace-db'
import { postTelegramText } from '@/lib/telegram/client'
import type { InboxEvent } from '@/lib/push-reasons'
import { queueFactoryCloudRun as queueCloudRun } from '@/lib/factory/queue-cloud'
import { ComputerStore } from '@/lib/computer/store'
import { bindBotSubscription } from '@/lib/computer/bot-subscription'
import { recordDecision, settleTurn } from '@/lib/attention/store'
import type { CreateIssueInput, UpdateIssueInput } from '@/lib/coordinator/issue-input'
import { systemActor } from '@/lib/activity-actor'

// Every function here is a durable step: it runs with full Node access, its
// result is recorded, and a failure is retried. Tools return `{ error }` for
// expected failures instead of throwing, so a bad id is not retried.

type ToolResult<T> = T | { error: string; reason?: string; detail?: string }

/** The deployment switches the Coordinator's tools depend on, read here because a workflow body never reads one (lib/deployment-switches.ts). */
export async function coordinatorSwitches() {
  'use step'
  return (await import('./tools')).readCoordinatorSwitches()
}

export async function computerToolsEnabled() {
  'use step'
  return cloudComputerRunsEnabled()
}

async function asToolResult<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof ActionFailureError) {
      // A refused run says why, so the Coordinator acts on the cause instead of guessing one.
      const detail = error.code === 'runInvalid' ? runInvalidDetail(error.params?.reason) : undefined
      return detail ? { error: error.code, reason: String(error.params!.reason), detail } : { error: error.code }
    }
    if (error instanceof FactoryError) return { error: error.code }
    throw error
  }
}

// `botId` picks the chat: one of the person's bots, their Coordinator included.

/** Whether this chat's bot is the person's Coordinator (lib/coordinator/coordinator-bot.ts). */
export async function isCoordinatorChat(userId: string, botId: string) {
  'use step'
  return (await import('@/lib/coordinator/coordinator-bot')).isCoordinatorBot(pool, userId, botId)
}

export async function takeInbox(userId: string, holder: string, botId: string) {
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

export async function releaseLease(userId: string, holder: string, botId: string) {
  'use step'
  return store.releaseLease(userId, holder, botId)
}

export async function failTurn(userId: string, holder: string, error: string, botId: string) {
  'use step'
  await store.failTurn(userId, holder, error, botId)
}

export async function appendMessages(userId: string, holder: string, messages: ModelMessage[], warning: string | null = null, botId: string, streamId?: string, stopped = false) {
  'use step'
  return store.appendMessages(userId, holder, messages, warning, botId, streamId, stopped)
}

/** What the model call cut short by 停止 had streamed in turn `streamId`, read back from this run's own stream (lib/coordinator/stop.ts). */
export async function stoppedStepText(holder: string, streamId: string) {
  'use step'
  const { getRun } = await import('workflow/api')
  const { stoppedStepText: read } = await import('@/lib/coordinator/stop')
  return read(getRun(holder).getReadable<CoordinatorWorkflowStreamPart>(), streamId)
}

/**
 * 订阅额度用完后，自动改用 API Key, or 点数不足时改用: when this turn was
 * frozen on another model because the subscription or the points ran out,
 * the chat says so before the reply.
 */
/**
 * Everything a Coordinator run reads once before its first round, in one step
 * (each step is a durable round trip of about a second): the deployment
 * switches, whether this chat is the Coordinator's, and the chat runtime.
 */
export async function turnSettings(userId: string, botId: string) {
  'use step'
  const { personalWritesEnabled } = await import('@/lib/operations/write-feature')
  const { runtime } = await import('./native-steps')
  const [coordinator, selected] = await Promise.all([
    (await import('@/lib/coordinator/coordinator-bot')).isCoordinatorBot(pool, userId, botId),
    runtime(userId),
  ])
  return { computerEnabled: cloudComputerRunsEnabled(), mailboxEnabled: personalMailboxEnabled(), writeEnabled: personalWritesEnabled(), switches: (await import('./tools')).readCoordinatorSwitches(), coordinator, runtime: selected }
}

/**
 * Everything a round needs between starting its execution and its first model
 * call, in one step: the mailbox catalogue, the model-switch notice and the
 * prompt. A retry after the notice was stored finds it as the last message and
 * does not store it twice.
 */
export async function prepareTurn(userId: string, botId: string, holder: string, input: { snapshot?: DefinitionSnapshot; executionId?: string; mailboxEnabled: boolean; runtime: { modelSelection?: unknown } | null }) {
  'use step'
  const mailboxTools = input.mailboxEnabled ? await mailboxCatalogue(userId, botId, input.executionId) : []
  if (input.runtime) await noteQuotaSwitch(userId, holder, input.runtime, botId, true)
  return { mailboxTools, prompt: await preparePrompt(userId, botId, input.snapshot, mailboxTools) }
}

export async function noteQuotaSwitch(userId: string, holder: string, runtime: { modelSelection?: unknown }, botId: string, once = false) {
  'use step'
  const { hostedModelSelectionSchema } = await import('@/lib/subscription-model-snapshot')
  const selection = hostedModelSelectionSchema.safeParse(runtime.modelSelection)
  if (!selection.success) return
  const kind = selection.data.afterPoints ? 'points_switch' : selection.data.type === 'api_key' && selection.data.afterQuota ? 'quota_switch' : null
  if (!kind) return
  // Inside prepareTurn a retried step must not store the notice twice: it would be the last message.
  if (once && await store.lastEventKind(userId, botId) === kind) return
  const { quotaSwitchMessage, pointsSwitchMessage } = await import('@/lib/coordinator/message-safety')
  // 点数不足时改用 (decision 2026-11-02-1450): Mikka 默认 had no points, this turn runs on the next allowed model.
  if (selection.data.afterPoints) await store.appendMessages(userId, holder, [pointsSwitchMessage(selection.data.modelId, new Date())], null, botId)
  else if (selection.data.type === 'api_key' && selection.data.afterQuota) await store.appendMessages(userId, holder, [quotaSwitchMessage(selection.data.afterQuota, new Date())], null, botId)
}

/**
 * One round's timing as one log line (`turn_timing`): how long from taking the
 * inbox to storing the reply, how many model calls, and each tool call's name
 * and duration. Durations and counts only. Each model call logs its own line
 * (`model_call_timing`, lib/model-call-timing.ts) with the same workflowRunId.
 */
export async function logTurnTiming(timing: { workflowRunId: string; round: number; route: 'hosted' | 'subscription' | 'native'; untilStoredMs: number; modelCalls: number | null; tools: { tool: string; ms: number; failed: boolean }[] }) {
  'use step'
  try { console.info(JSON.stringify({ msg: 'turn_timing', ...timing })) } catch { /* timing never fails the turn */ }
}

export async function writeStreamPart(writable: WritableStream<CoordinatorWorkflowStreamPart>, part: CoordinatorWorkflowStreamPart) {
  'use step'
  const writer = writable.getWriter()
  try { await writer.write(part) } finally { writer.releaseLock() }
}

/** Every chunk revalidates its source, owner, chat lease and current Telegram
 * link. A cached earlier step cannot turn a revoked link into send authority.
 * Telegram has no idempotency key: response loss can remain externally uncertain. */
export async function sendTelegramChunk(userId: string, botId: string, holder: string, target: PendingTelegramTarget, chunk: string) {
  'use step'
  await createTelegramReplies(pool, workspacePool).send(userId, botId, holder, target, tx => postTelegramText(target.threadId, chunk, tx))
}

export async function acknowledgeTelegramReply(userId: string, botId: string, holder: string, target: PendingTelegramTarget) {
  'use step'
  await createTelegramReplies(pool, workspacePool).acknowledge(userId, botId, holder, target)
}

/** Pushes a reply the Coordinator raised on its own to the person's phones, as their 通知 settings allow (lib/mobile-push.ts). */
export async function pushToPhones(userId: string, botId: string, text: string | null, events: InboxEvent[]) {
  'use step'
  await (await import('@/lib/coordinator/push-decision')).pushByDecision(userId, botId, text, events)
}

/**
 * The turn failed for a reason the person can act on (Mikka 默认 or their
 * subscription refused it): the web keeps that under their message, but
 * Telegram and the phone would hear nothing. They get the same words instead
 * (lib/coordinator/refusal-line.ts). Any other failure, and a scheduled read,
 * sends nothing here. Never throws: the turn's own failure is what the caller records.
 */
export async function noticeTurnFailure(userId: string, botId: string, holder: string, error: string, telegramTargets: readonly PendingTelegramTarget[], pushEvents: readonly InboxEvent[]) {
  'use step'
  const { failureLine, deliverRefusalLine } = await import('@/lib/coordinator/refusal-line')
  const line = failureLine(error)
  if (!line) return false
  const replies = createTelegramReplies(pool, workspacePool)
  const { failed } = await deliverRefusalLine(line, telegramTargets, pushEvents, {
    telegram: async (target, text) => {
      await replies.send(userId, botId, holder, target, tx => postTelegramText(target.threadId, text, tx))
      await replies.acknowledge(userId, botId, holder, target)
    },
    push: (text, events) => pushToPhones(userId, botId, text, events),
  })
  if (failed.length) console.error('Failure notice failed:', failed.join(', '))
  return true
}
// A sent Telegram line has no idempotency key: never replay it.
noticeTurnFailure.maxRetries = 0

/**
 * Folds older messages into the summary once the conversation passes the
 * token budget, then returns the prompt for this turn: the instructions with
 * the person's memory, and the messages.
 */
export async function preparePrompt(userId: string, botId: string, snapshot?: DefinitionSnapshot, mailboxTools: readonly MailboxToolName[] = []): Promise<{ instructions: string; stable: number; messages: ModelMessage[] }> {
  'use step'
  // Fallback only: run completion already reconciles (lib/run-completion-effects.ts
  // reconcileFactoryAfterCompletion). This catches completions whose hook failed.
  if (deploymentSwitch('factoryRouting') && deploymentSwitch('factoryLifecycle')) {
    const { factoryRuntimeForBot } = await import('@/lib/factory/runtime')
    await factoryRuntimeForBot(botId).reconcile(userId)
  }

  let { summary, memory, messages } = await store.loadConversation(userId, botId)
  if (messages.some(row => 'mikkaUserEvent' in row.message && typeof row.message.content === 'string' && row.message.content.includes('[mikka-file:'))) {
    const { chatFileContent } = await import('@/lib/chat-attachments/store')
    messages = await Promise.all(messages.map(async row => {
      if (!('mikkaUserEvent' in row.message) || row.message.role !== 'user' || typeof row.message.content !== 'string' || !row.message.content.includes('[mikka-file:')) return row
      return { ...row, message: { ...row.message, content: await chatFileContent(userId, { kind: 'bot', id: botId }, row.message.content) } }
    }))
  }
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
  // The hosted Coordinator renders OpenUI like the native one, so it gets the same presentation rules and catalog.
  const base = withCoordinatorPresentation(snapshot ? executionInstructions(snapshot) : await botInstructions(userId, botId, COORDINATOR_INSTRUCTIONS))
  const instructions = personalMailboxEnabled() && snapshot ? personalMailboxInstructions(base, snapshotMailboxTools(snapshot).filter(name => mailboxTools.includes(name))) : base
  const factoryPolicy = deploymentSwitch('factoryRouting') && deploymentSwitch('factoryLifecycle') ? FACTORY_QUESTION_INSTRUCTIONS + FACTORY_CHECK_RECOVERY_INSTRUCTIONS : ''
  // The person's 个人指令 sit after the rules and before the memory, marked as theirs.
  // The person's own GitHub account, so the Bot looks a repository up instead of asking which account it is under.
  const { githubContext } = await import('@/lib/coordinator/github-context')
  const { executionContextParts } = await import('@/lib/coordinator/execution-context')
  const execution = await executionContextParts(userId, botId)
  // Everything up to the memory is the same on every turn; `stable` is where it ends, so a provider can cache it (lib/prompt-cache.ts).
  const rules = await withPersonalInstructions(userId, instructions, snapshot ? snapshot.personalPlugins ?? { servers: [], skills: [] } : undefined)
  // The GitHub lines (the authorized repository list) and the allowed models list are part of the cached prefix: they change only
  // when the repositories or 优先使用的模型 do. Which models can run right now changes per turn, so it stays after the memory.
  const prompt = promptWithCachedContext(rules, cachedContextLines(await githubContext(userId, undefined, undefined, botId), execution.models), memory, factoryPolicy + '\n' + SCHEDULE_INSTRUCTIONS + (execution.live ? '\n' + execution.live : ''))
  return { ...prompt, messages: promptMessages(summary, messages, summaryTrust) }
}

export async function personalWriteToolsEnabled() { 'use step'; const { personalWritesEnabled } = await import('@/lib/operations/write-feature'); return personalWritesEnabled() }

export async function mailboxToolsEnabled() { 'use step'; return personalMailboxEnabled() }
export async function mailboxCatalogue(userId: string, botId: string, executionId?: string) {
  'use step'
  if (!personalMailboxEnabled()) return []
  const { personalConversationMailboxAdvertised } = await import('@/lib/personal-mailbox-runtime')
  return personalConversationMailboxAdvertised(userId, botId, executionId)
}
export async function personalMailbox(userId: string, botId: string, request: MailboxToolRequest, scope?: NativeToolScope, executionId?: string) {
  'use step'
  if(scope?.scheduledRead)throw new FatalError('scheduleToolNotAllowed')
  await assertNativeToolScope(userId, scope)
  if (!personalMailboxEnabled()) return { error: 'personal_mailbox_unavailable' }
  const { personalConversationMailbox } = await import('@/lib/personal-mailbox-runtime')
  const result = await personalConversationMailbox(userId, botId, request, scope?.holder!==undefined?scope:undefined, executionId)
  return result.body
}

export async function remember(userId: string, input: { note: string }, scope: NativeToolScope | undefined, botId: string) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return store.editMemory(userId, memory => {
    const next = rememberNote(memory, input.note)
    return next === null ? { error: 'memoryFull: forget something first' } : { memory: next, result: { remembered: true } }
  }, botId)
}

export async function forget(userId: string, input: { text: string }, scope: NativeToolScope | undefined, botId: string) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return store.editMemory(userId, memory => {
    const { memory: next, removed } = forgetNotes(memory, input.text)
    return { memory: next, result: { removed } }
  }, botId)
}

/** 团队权限 › 允许使用的应用: a workspace can block an app for its bots. The person's Coordinator is not governed (lib/app-policy/store.ts). */
async function appBlockedForBot(botId: string | undefined, action: ComposioActionName) {
  if (!botId) return false
  const { botMayUseApp } = await import('@/lib/app-policy/store')
  const { isPolicyApp } = await import('@/lib/app-policy/apps')
  // Loaded here, not at module top: steps.ts is imported by suites that stub 'ai', which composio-actions needs.
  const { COMPOSIO_ACTIONS } = await import('@/lib/composio-actions')
  const toolkit = COMPOSIO_ACTIONS[action]?.toolkit
  return Boolean(toolkit && isPolicyApp(toolkit) && !(await botMayUseApp(botId, toolkit)))
}

export async function composioAction(userId: string, action: ComposioActionName, input: unknown, scope?: NativeToolScope, accountId?: string, botId?: string) {
  'use step'
  await assertNativeToolScope(userId,scope)
  if (await appBlockedForBot(botId, action)) return { error: 'integrationBlockedByWorkspace' }
  return accountId ? runComposioAction(userId, action, input, accountId) : runComposioAction(userId, action, input)
}

export async function personalMcp(userId: string, botId: string, executionId: string | undefined, input: import('@/lib/plugins/mcp').PersonalMcpCommand, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  // Scheduled read grants never authorize arbitrary remote MCP tools.
  if (scope?.scheduledRead) return { error: 'mcpNotAllowedForScheduledRead' }
  const { agentScope, agentKitStore } = await import('@/lib/agent-kit/service')
  const ownerScope = await agentScope(userId, botId)
  const execution = executionId ? await agentKitStore.readExecution(ownerScope, executionId) : null
  if (execution && execution.status !== 'running') return { error: 'agentExecutionClosed' }
  const { runPersonalMcp } = await import('@/lib/plugins/runtime')
  return runPersonalMcp(userId, execution ? execution.snapshot.personalPlugins ?? { servers: [], skills: [] } : undefined, input)
}
// Remote tools may have side effects and no idempotency key. The workflow must
// preserve the first uncertain outcome rather than replaying this step.
personalMcp.maxRetries = 0

/** GitHub's hosted MCP server as the caller, with the caller's own token only (decision 2026-11-02-1730). */
export async function githubMcp(userId: string, input: import('@/lib/plugins/mcp').McpCommand, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (scope?.scheduledRead) return { error: 'mcpNotAllowedForScheduledRead' }
  const { createGitHubMcpRuntime, GITHUB_MCP_MIN_VALIDITY_MS } = await import('@/lib/github/mcp')
  const { githubTokenForUser } = await import('@/lib/github/user-access')
  return createGitHubMcpRuntime(owner => githubTokenForUser(owner, { minValidityMs: GITHUB_MCP_MIN_VALIDITY_MS }))(userId, input)
}
// A GitHub write has no idempotency key; never replay an uncertain call.
githubMcp.maxRetries = 0

/** Apps connected from the 插件 store, through the tools Composio lists for them (lib/app-tools.ts). */
export async function appTools(userId: string, botId: string, operation: 'list' | 'call', input: unknown, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (scope?.scheduledRead && operation === 'call') return { error: 'integrationActionNotAllowed' }
  const { runAppTools } = await import('@/lib/app-tools-server')
  return runAppTools(userId, botId, operation, input)
}
// A write may have happened even when its step fails; never replay it.
appTools.maxRetries = 0

export async function accountWrite(userId: string, action: ApprovalActionName, input: unknown, scope?: NativeToolScope, accountId?: string, botId?: string) {
  'use step'
  await assertNativeToolScope(userId,scope)
  if (await appBlockedForBot(botId, action)) return { error: 'integrationBlockedByWorkspace' }
  return writeAccountAction(userId, action, input, accountId, botId ?? null)
}
// A send has no idempotency key: a replayed step could send it twice.
accountWrite.maxRetries = 0

export async function listIssues(userId: string, input: { status?: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  const rows = await db.selectDistinct({ id: issues.id, title: issues.title, status: issues.status, priority: issues.priority, content: issueAttrsContent, updatedAt: issues.updatedAt })
    .from(issues).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
    .where(and((await issueVisibility(userId)).predicate, input.status ? eq(issues.status, input.status) : undefined))
    .orderBy(desc(issues.updatedAt)).limit(100)
  return rows.filter(row => !readIssueMetadata(row.content).deletedAt).slice(0, 50).map(({ content, updatedAt, ...row }) => ({
    ...row, number: readIssueMetadata(content).number ?? null, updatedAt: updatedAt.toISOString(),
  }))
}

export async function getIssue(userId: string, input: { issueId: string }, scope: NativeToolScope | undefined, botId: string) {
  'use step'
  await assertNativeToolScope(userId,scope)
  const issue = await issueForUser(userId, input.issueId)
  if (!issue) return { error: 'issueNotFound' }
  const runs = await visibleRuns(userId, { issueId: issue.id, limit: 5 })
  // The task's one thread, so more work goes to it (decision 2026-11-01-1330): its repository is already known.
  const latest = await (await import('@/lib/thread-dispatch')).latestTaskRun(pool, userId, issue.id)
  return {
    id: issue.id, number: readIssueMetadata(issue.content).number ?? null, title: issue.title,
    status: issue.status, priority: issue.priority, body: tiptapToText(issue.content).slice(0, 8000),
    runs: runs.map(run => ({ id: run.id, agent: run.agentName, status: run.status, createdAt: run.createdAt.toISOString() })),
    thread: latest ? { runId: latest.id, status: latest.status, repository: latest.remoteUrl } : null,
    ...(deploymentSwitch('factoryRouting') ? { factory: await (await import('@/lib/factory/server')).factoryForBot(botId).listForIssue(userId,issue.id) } : {}),
  }
}

export async function createIssue(userId: string, input: CreateIssueInput, toolCallId: string, scope: NativeToolScope | undefined, botId: string, taskEventId?: string, sourceEventId?: string) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (!toolCallId || toolCallId.length > 200) return { error: 'issueToolCallConflict' }
  // A team workspace's bot creates the task in that workspace's team, not as its owner's personal task.
  const team = await (await import('@/lib/coordinator/issue-team')).coordinatorIssueTeam(userId, botId, input.teamId)
  if ('error' in team) return team
  return (await import('@/lib/mcp/actions')).createIssue(userId, input, systemActor(botId), toolCallId, taskEventId ? { eventId: taskEventId, botId } : undefined, team.teamId ?? undefined, !taskEventId && sourceEventId ? { eventId: sourceEventId, botId } : undefined)
}

export async function updateIssue(userId: string, input: UpdateIssueInput, toolCallId: string, scope: NativeToolScope | undefined, botId: string) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (!toolCallId || toolCallId.length > 200) return { error: 'issueToolCallConflict' }
  return (await import('@/lib/mcp/actions')).updateIssue(userId, input, systemActor(botId), toolCallId)
}

export async function listAgents(userId: string, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return (await import('@/lib/mcp/actions')).listAgents(userId)
}

/** The host's user only: their own GitHub token's authorized repositories, never another person's. */
export async function findRepository(userId: string, input: { name?: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return (await import('@/lib/coordinator/repository-resolution')).findRepository(userId, input.name)
}

/**
 * The run belongs to the bot that dispatched it, the Coordinator included, so its events come back to that bot's chat.
 * One task, one thread (lib/thread-dispatch.ts): a task with a thread gets the dispatch as that thread's work; only
 * `newThread`, when the person's own message (`sourceEventId`, host-supplied) explicitly asked for it, starts another.
 */
export async function dispatchRun(userId: string, input: { issueId: string; agentId?: string; repo?: string; note?: string; requestKey?:string; readOnly?: boolean; newThread?: boolean; sourceEventId?: string; target?: import('@/lib/dispatch-target').DispatchTarget; model?: { harness: 'claude_code' | 'codex'; model?: string } }, scope: NativeToolScope | undefined, botId: string, execution?: AgentExecution, requestEventId?: string) {
  'use step'
  await assertNativeToolScope(userId,scope)
  if (!(await import('@/lib/factory/runtime')).factoryLifecycleEnabled()) return { error: 'factoryLifecycleUnavailable' as const }
  const { newThread, sourceEventId, target, ...request } = input
  requestEventId ??= sourceEventId
  // The Agent or model the Bot named must be one of 优先使用的模型, the list its prompt shows; otherwise nothing is queued.
  if (request.model) {
    const { modelNotAllowed } = await import('@/lib/model-dispatch')
    const refused = await modelNotAllowed(pool, { ownerId: userId, workspaceId: await (await import('@/lib/execution-settings')).executionWorkspace(userId, botId) }, request.model)
    if (refused) return { ...refused, issueId: request.issueId }
  }
  const { dispatchToTask, explicitNewThread } = await import('@/lib/thread-dispatch')
  const { movesThread, runPlacement } = await import('@/lib/dispatch-target')
  // The result says where the work actually runs, so the reply names that place and no other (decision 2026-11-01-1330).
  const placed = async <T,>(result: T): Promise<T> => {
    if (!result || typeof result !== 'object' || !('runId' in result) || typeof result.runId !== 'string') return result
    const { timedPhase } = await import('@/lib/dispatch-timing')
    return { ...result, placement: await timedPhase('runPlacement', () => runPlacement(pool, userId, result.runId as string)) }
  }
  // A bare name ("Mikka_test") becomes the one repository this user authorized by that name, or a card; only a new run needs it.
  const { withResolvedRepository } = await import('@/lib/coordinator/repository-resolution')
  // A new thread runs in the repository named; the thread's next run only ever in the thread's own (never the one the model passed).
  const byRules = (note: string | undefined, place: import('@/lib/dispatch-target').DispatchTarget | undefined, named: string | null | undefined, previousRunId?: string) => {
    if (!named?.trim()) return Promise.resolve({ error: 'repositoryRequired' as const, issueId: request.issueId })
    return withResolvedRepository(userId, request.issueId, named, repo => dispatchByRules(userId, { ...request, repo, note, threadRunId: previousRunId }, scope, botId, execution, requestEventId, place))
  }
  // The thread's repository is not the one named: a different one, or a name that is not one repository yet (its card comes from the new thread's lookup).
  let repositoryMove = false
  const movesRepository = async (previous: import('@/lib/thread-dispatch').TaskThreadRun) => {
    if (!request.repo?.trim() || !previous.remoteUrl) return false
    const { sameRepository } = await import('@/lib/coordinator/repository-resolution')
    repositoryMove = (await sameRepository(userId, request.repo, previous.remoteUrl).catch(() => null)) !== true
    return repositoryMove
  }
  const { withDispatchTiming } = await import('@/lib/dispatch-timing')
  return asToolResult(() => withDispatchTiming(async () => placed(await dispatchToTask(userId, request.issueId, {
    note: request.note, newThread,
    // A named place other than the thread's own is a move, which only the person's explicit request grants. So is a
    // repository the person named that is not the thread's ("It's in the mikka-web repo"): the work goes there, in a new thread.
    moves: async previous => movesThread(target, await runPlacement(pool, userId, previous.id)) || await movesRepository(previous),
    explicit: async () => (repositoryMove && await personNamed(userId, botId, sourceEventId, request.repo!)) || explicitNewThread(userId, botId, sourceEventId),
    start: async (previous, note, replaces) => {
      // A new thread runs in the repository the person named, else in the one of the thread it replaces.
      if (!previous) return byRules(note, target, request.repo?.trim() || replaces?.remoteUrl)
      // The thread's next run goes where the thread ran, so its session can be resumed; elsewhere it starts fresh with the note's context.
      // It keeps the thread's own model and account, or the one the person just named; never another one silently.
      const { latestThreadRunModel, chooseCloudRunModel, chooseLocalRunModel } = await import('@/lib/computer/run-model')
      const threadModel = await latestThreadRunModel(pool, userId, request.issueId, previous.agentId)
      if (previous?.cloud && (previous.harness === 'codex' || previous.harness === 'claude_code')) {
        const named = request.model?.model ? await chooseCloudRunModel(pool, { ownerId: userId, workspaceId: previous.cloud.workspaceId, botId: previous.cloud.botId }, previous.agentId, previous.harness, request.model.model) : null
        const runModel = named ?? threadModel
        if (!runModel || 'error' in runModel) return { error: 'threadModelUnavailable' as const, issueId: request.issueId, threadRunId: previous.id }
        const cloud = await dispatchComputerTask(userId, { botId: previous.cloud.botId, factoryBotId: botId, sourceEventId: requestEventId, issueId: request.issueId, harness: previous.harness, note, ...runModel, threadRunId: previous.id, ...(previous.remoteUrl ? { repo: previous.remoteUrl } : {}), ...(request.readOnly || previous.readOnly ? { readOnly: true } : {}) }, `thread:${previous.id}:${request.requestKey ?? requestEventId ?? crypto.randomUUID()}`, scope, execution)
        if (!('error' in cloud)) return cloud
        if (cloud.error !== 'cloudComputerUnavailable') return { ...cloud, issueId: request.issueId }
      } else if (previous?.remoteUrl) {
        // A server or computer thread keeps its own model too; with none left the person is told, never the CLI's pick.
        const device = request.model?.model ? (await pool.query<{ deviceId: string; harness: 'codex' | 'claude_code'; workspaceId: string }>('SELECT a."deviceId",a.harness FROM agents a WHERE a.id=$1 AND a."userId"=$2', [previous.agentId, userId])).rows[0] : undefined
        const named = device ? await chooseLocalRunModel(pool, { ownerId: userId, workspaceId: await (await import('@/lib/execution-settings')).executionWorkspace(userId, botId), botId }, { id: previous.agentId, deviceId: device.deviceId, harness: device.harness }, request.model!.model) : null
        const localModel = named && !('error' in named) ? named : threadModel
        if (!localModel) return { error: 'threadModelUnavailable' as const, issueId: request.issueId, threadRunId: previous.id }
        // Read-only sticks: a read-only request, or a thread that runs read-only, gives a read-only next run.
        const result = await queueTaskRun(userId, { issueId: request.issueId, agentId: previous.agentId, repo: previous.remoteUrl, note, readOnly: Boolean(request.readOnly || previous.readOnly), requestKey: `thread:${previous.id}:${request.requestKey ?? crypto.randomUUID()}`.slice(0, 200), ...localModel, threadRunId: previous.id }, botId, execution, requestEventId).catch(error => { if (error instanceof FactoryError) throw error; return null })
        if (result) return { ...result, status: 'queued' as const }
      }
      // Where the thread ran could not take it: placed by the rules, in the thread's repository and at the place the person named, if any.
      return byRules(note, target, previous.remoteUrl, previous.id)
    },
  }))))
}

/** Whether the person's own message (host-supplied event) names this repository: their words, not the model's, grant a move. */
async function personNamed(userId: string, botId: string, sourceEventId: string | undefined, repo: string) {
  if (!sourceEventId) return false
  const { rows: [event] } = await pool.query(`SELECT payload->>'text' AS text FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND kind='user_message' AND "botId" IS NOT DISTINCT FROM $3::uuid`, [sourceEventId, userId, botId])
  const loose = (value: string) => value.toLowerCase().replace(/[-_. ]+/g, '')
  const name = repo.trim().replace(/^(?:https:\/\/|git@)github\.com[/:]/i, '').replace(/\.git$/i, '').split('/').pop() ?? ''
  return typeof event?.text === 'string' && name.length > 0 && loose(event.text).includes(loose(name))
}

/** Where a new run goes and on which model (decision 2026-11-02-1400): a named computer, else 运行位置; the model by the same rule either way. */
async function dispatchByRules(userId: string, input: { threadRunId?: string; issueId: string; agentId?: string; repo: string; note?: string; requestKey?:string; readOnly?: boolean; model?: { harness: 'claude_code' | 'codex'; model?: string } }, scope: NativeToolScope | undefined, botId: string, execution?: AgentExecution, requestEventId?: string, place?: import('@/lib/dispatch-target').DispatchTarget) {
  // A computer the person named: theirs, not removed, online; otherwise refused or the card at once, never another computer.
  if (place && place !== 'cloud') {
    const { targetDevice } = await import('@/lib/dispatch-target')
    const device = await targetDevice(pool, userId, place.deviceId)
    if ('error' in device) return device.error === 'notFound'
      ? { error: 'deviceNotFound' as const }
      : { error: 'machineUnavailable' as const, issueId: input.issueId, card: (await import('@/lib/rule-dispatch')).machineUnavailableCard() }
    // The named computer fixes where; the model is chosen as for any run (the thread's own, else 优先使用的模型 in order), among what this computer runs.
    const { issueForUser } = await import('@/lib/issue-access')
    if (!await issueForUser(userId, input.issueId)) throw new ActionFailureError('issueNotFound')
    const { executionWorkspace } = await import('@/lib/execution-settings')
    const { resolveModelDispatch } = await import('@/lib/model-dispatch')
    const target = await resolveModelDispatch(pool, { ownerId: userId, workspaceId: await executionWorkspace(userId, botId), botId }, input.model ?? null, 'local', device.deviceId)
    if (target.kind !== 'device') return { error: 'machineUnavailable' as const, issueId: input.issueId, ...(target.kind === 'none' ? { reason: target.reason, card: target.card } : {}) }
    const result = await queueTaskRun(userId, { ...input, agentId: target.agentId, model: target.model, pinnedDeviceId: target.deviceId, ...(target.subscriptionBindingId ? { subscriptionBindingId: target.subscriptionBindingId } : {}), ...(target.entry.source.kind === 'api_key' ? { apiKeyId: target.entry.source.keyId } : {}) }, botId, execution, requestEventId)
    return { ...result, status: 'queued' as const }
  }
  {
    // 模型与订阅 (decision 2026-11-02-1400): the thread's own model, else 优先使用的模型 in order; 运行位置 says where
    // (decision 2026-11-02-2330: 云端 the cloud, then a server, then a computer; 本地 a server, then a computer).
    // The person asking for the cloud runs it there whatever 运行位置 says, and nowhere else.
    const { timedPhase } = await import('@/lib/dispatch-timing')
    const { issueForUser } = await import('@/lib/issue-access')
    if (!await timedPhase('issueForUser', () => issueForUser(userId, input.issueId))) throw new ActionFailureError('issueNotFound')
    const { executionWorkspace } = await import('@/lib/execution-settings')
    const workspaceId = await timedPhase('executionWorkspace', () => executionWorkspace(userId, botId))
    const { resolveModelDispatch } = await import('@/lib/model-dispatch')
    const target = await timedPhase('resolveModelDispatch', () => resolveModelDispatch(pool, { ownerId: userId, workspaceId, botId }, input.model ?? null, place === 'cloud' ? 'cloud' : undefined))
    if (target.kind === 'none') {
      if (target.reason === 'cloudNotConfigured') {
        const { cloudDispatchFailureReason } = await import('@/lib/cloud-dispatch-failure')
        const { modelUnavailableCard } = await import('@/lib/model-dispatch')
        const reason = await cloudDispatchFailureReason(pool, userId)
        return { error: 'machineUnavailable' as const, issueId: input.issueId, reason, card: modelUnavailableCard(reason) }
      }
      return { error: 'machineUnavailable' as const, issueId: input.issueId, reason: target.reason, card: target.card }
    }
    const onDevice = async (device: Extract<typeof target, { kind: 'device' }>) => {
      const result = await queueTaskRun(userId, { ...input, agentId: device.agentId, model: device.model, pinnedDeviceId: device.deviceId, ...(device.subscriptionBindingId ? { subscriptionBindingId: device.subscriptionBindingId } : {}), ...(device.entry.source.kind === 'api_key' ? { apiKeyId: device.entry.source.keyId } : {}) }, botId, execution, requestEventId)
      return { ...result, status: 'queued' as const }
    }
    if (target.kind === 'device') return onDevice(target)
    if (requestEventId) {
      const event=(await pool.query('SELECT "userId","botId",payload FROM coordinator_events WHERE id=$1',[requestEventId])).rows[0]
      if (!event || event.userId!==userId || event.botId!==botId || event.payload?.taskDestination) throw new ActionFailureError('runInvalid')
    }
    // The bot's own runtime, created on first use; the Coordinator's is its bot row's like any bot's.
    // An API-key model binds no subscription to it; a subscription model binds the entry's own account.
    const autoRuntime=await import('@/lib/computer/auto-runtime')
    const actor={userId,workspaceId}
    const runtime=await timedPhase('ensureBotCloudRuntime', () => autoRuntime.ensureBotCloudRuntime(pool,actor,botId,{harness:target.harness}))
    const { bindAgentToConnection } = await import('@/lib/model-dispatch')
    const source = target.entry.source
    const subscriptionBindingId = runtime && source.kind === 'subscription' ? await timedPhase('bindAgentToConnection', () => bindAgentToConnection(pool, { ownerId: userId, workspaceId }, runtime.agentId, target.harness, source.connectionId, target.model)) : undefined
    const cloud = runtime ? await dispatchComputerTask(userId,{botId:runtime.botId,issueId:input.issueId,harness:runtime.harness,note:input.note,model:target.model,repo:input.repo,threadRunId:input.threadRunId,sourceEventId:requestEventId,factoryBotId:botId,...(subscriptionBindingId ? {subscriptionBindingId} : {}),...(target.entry.source.kind === 'api_key' ? {apiKeyId:target.entry.source.keyId} : {}),...(input.readOnly ? {readOnly:true} : {})},`rule:${input.requestKey ?? requestEventId ?? crypto.randomUUID()}`,scope,execution) : { error: 'cloudComputerUnavailable' as const }
    if (!('error' in cloud) || cloud.error !== 'cloudComputerUnavailable') return cloud
    // 云端 could not start it (the key refused, a limit, the template, E2B down, the worker never came up;
    // the queued cloud run is already ended): a server, else a computer, unless the person asked for the cloud.
    if (place !== 'cloud') {
      const fallback = await resolveModelDispatch(pool, { ownerId: userId, workspaceId, botId }, input.model ?? null, undefined, undefined, { withoutCloud: true })
      if (fallback.kind === 'device') return { ...await onDevice(fallback), fallback: 'cloudUnavailable' as const }
    }
    // A startup failure can be capacity, quota, template or service availability. Only a confirmed
    // missing key offers 填入 E2B Key; an existing key must never be described as absent.
    const { modelUnavailableCard } = await import('@/lib/model-dispatch')
    const { cloudDispatchFailureReason } = await import('@/lib/cloud-dispatch-failure')
    const reason = await cloudDispatchFailureReason(pool, userId)
    return { error: 'machineUnavailable' as const, issueId: input.issueId, reason, card: modelUnavailableCard(reason) }
  }
}

/** Only the person's own Bots in workspaces they still belong to are listed. */
export async function listComputerWorkspaces(userId: string, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (!cloudComputerRunsEnabled()) return { error: 'cloudComputerUnavailable' }
  const [{ workspaceDb }, { workspaces, workspaceMembers }] = await Promise.all([import('@/lib/workspace-db'), import('@/lib/db/workspace-schema')])
  return workspaceDb.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'))).orderBy(asc(workspaces.createdAt)).limit(50)
}

/** The tool call id makes a retried Bot creation idempotent. */
export async function createComputerBot(userId: string, input: { workspaceId: string; name: string }, toolCallId: string, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (!cloudComputerRunsEnabled() || !toolCallId || toolCallId.length > 200) return { error: 'cloudComputerUnavailable' }
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
  if (!cloudComputerRunsEnabled()) return { error: 'cloudComputerUnavailable' }
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

/** `dispatch_bot_computer`: on a task that has a thread, that thread's next work (lib/thread-dispatch.ts), on this Bot's computer. */
export async function dispatchComputerThread(userId: string, input: { botId: string; issueId: string; harness: 'codex' | 'claude_code'; model?: string; note?: string; suggestionId?: string; readOnly?: boolean; newThread?: boolean; sourceEventId?: string }, toolCallId: string, scope?: NativeToolScope, execution?: AgentExecution, chatBotId?: string) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (!(await import('@/lib/factory/runtime')).factoryLifecycleEnabled()) return { error: 'factoryLifecycleUnavailable' as const }
  const { newThread, sourceEventId, model: asked, ...request } = input
  // A model the Bot named must be one of 优先使用的模型 of the computer Bot's workspace, the list its prompt shows; otherwise nothing is queued.
  if (asked) {
    const bot = (await pool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 AND "archivedAt" IS NULL', [request.botId, userId])).rows[0]
    if (!bot) return { error: 'cloudComputerUnavailable' as const }
    const { modelNotAllowed } = await import('@/lib/model-dispatch')
    const refused = await modelNotAllowed(pool, { ownerId: userId, workspaceId: bot.workspaceId }, { harness: request.harness, model: asked })
    if (refused) return { ...refused, issueId: request.issueId }
  }
  const { dispatchToTask, explicitNewThread } = await import('@/lib/thread-dispatch')
  return asToolResult(() => dispatchToTask(userId, request.issueId, {
    note: request.note, newThread,
    explicit: () => explicitNewThread(userId, chatBotId ?? request.botId, sourceEventId),
    // Read-only sticks across the thread's runs, as on a computer.
    start: async (previous, note) => {
      // A new thread takes 优先使用的模型's first cloud entry for this harness; the thread's next run keeps its own model.
      const runtime = (await pool.query<{ workspaceId: string; agentId: string }>('SELECT r."workspaceId",r."agentId" FROM bot_cloud_runtimes r WHERE r."botId"=$1 AND r."ownerId"=$2 AND r.harness=$3', [request.botId, userId, request.harness])).rows[0]
      if (!runtime) return { error: 'cloudComputerUnavailable' as const }
      const { latestThreadRunModel, chooseCloudRunModel } = await import('@/lib/computer/run-model')
      const choose = () => chooseCloudRunModel(pool, { ownerId: userId, workspaceId: runtime.workspaceId, botId: request.botId }, runtime.agentId, request.harness, asked)
      // The thread keeps its own model unless the person named another one from the list.
      const named = previous && asked ? await choose() : null
      const runModel = previous ? (named && !('error' in named) ? named : await latestThreadRunModel(pool, userId, request.issueId, previous.agentId)) : await choose()
      if (!runModel) return { error: 'threadModelUnavailable' as const, issueId: request.issueId, threadRunId: previous!.id }
      if ('error' in runModel) return { ...runModel, issueId: request.issueId }
      return dispatchComputerTask(userId, { ...request, factoryBotId: chatBotId ?? request.botId, sourceEventId, note, ...runModel, ...(previous ? { threadRunId: previous.id } : {}), ...(request.readOnly || previous?.readOnly ? { readOnly: true } : {}) }, previous ? `thread:${previous.id}:${toolCallId}` : toolCallId, scope, execution)
    },
  }))
}

/** Queue and bind atomically, with a stable tool-call id for workflow retries. */
export async function dispatchComputerTask(userId: string, input: { sourceEventId?: string; factoryBotId?: string | null; botId: string; issueId: string; harness: 'codex' | 'claude_code'; note?: string; model: string; threadRunId?: string; repo?:string; suggestionId?: string; readOnly?: boolean; apiKeyId?: string; subscriptionBindingId?: string; /** An MCP-owned thread retains its original result destination. */ withoutBot?: boolean }, toolCallId: string, scope?: NativeToolScope, execution?: AgentExecution) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (!(await import('@/lib/factory/runtime')).factoryLifecycleEnabled()) return { error: 'factoryLifecycleUnavailable' as const }
  if (!cloudComputerRunsEnabled() || !toolCallId || toolCallId.length > 200) return { error: 'cloudComputerUnavailable' }
  const target = (await pool.query(`SELECT b."workspaceId",r."agentId",r."repoId",a."deviceId" FROM bots b
    JOIN bot_cloud_runtimes r ON r."botId"=b.id AND r."ownerId"=b."ownerId" AND r."workspaceId"=b."workspaceId"
    JOIN agents a ON a.id=r."agentId" AND a."userId"=b."ownerId"
    WHERE b.id=$1 AND b."ownerId"=$2 AND r.harness=$3`, [input.botId, userId, input.harness])).rows[0]
  if (!target) return { error: 'cloudComputerUnavailable' }
  const { timedPhase } = await import('@/lib/dispatch-timing')
  try { await timedPhase('authorizeSubscriptionWorkspace', async () => (await import('@/lib/subscription-runtime')).authorizeSubscriptionWorkspace(userId, target.workspaceId)) } catch { return { error: 'cloudComputerUnavailable' } }
  const issue = await timedPhase('issueForUser', () => issueForUser(userId, input.issueId))
  if (!issue) return { error: 'issueNotFound' }
  let queuedRunId: string | null = null
  try {
    if (input.suggestionId && !(await pool.query('SELECT 1 FROM suggestion_executions WHERE "suggestionId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND ("botId" IS NULL OR "botId"=$4)', [input.suggestionId, userId, target.workspaceId, input.botId])).rowCount) return { error: 'suggestionUnavailable' }
    const deviceRepoId = input.repo ? (await timedPhase('ensureDeviceRepository', async () => (await import('@/lib/device-repositories')).ensureDeviceRepository(userId,target.deviceId,input.repo!))).id : target.repoId
    const result = await timedPhase('queueCloudRun', () => queueCloudRun(pool, { userId, workspaceId: target.workspaceId }, { botId: input.botId, factoryBotId: input.factoryBotId, sourceEventId: input.sourceEventId, issueId: issue.id, agentId: target.agentId, deviceRepoId, title: issue.title, body: tiptapToText(issue.content), note: input.note, model: input.model, ...(input.threadRunId ? { threadRunId: input.threadRunId } : {}), ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}), ...(input.subscriptionBindingId ? { subscriptionBindingId: input.subscriptionBindingId } : {}), ...(input.withoutBot ? { withoutBot: true } : {}), idempotencyKey: input.suggestionId ? `suggestion:${input.suggestionId}` : `coordinator:${toolCallId}`, execution, ...(input.readOnly ? { readOnly: true } : {}) }))
    if (input.suggestionId) await pool.query('UPDATE suggestion_executions SET "botId"=$4,"runId"=$5,status=\'running\' WHERE "suggestionId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND ("runId" IS NULL OR "runId"=$5)', [input.suggestionId, userId, target.workspaceId, input.botId, result.runId])
    const actor = { userId, workspaceId: target.workspaceId as string }
    queuedRunId = result.runId
    await timedPhase('ensureThreadMachine', async () => (await import('@/lib/cloud-computer/thread-machines')).ensureThreadMachine(pool, actor, result.runId))
    const { start } = await import('workflow/api')
    const { threadMachineLifecycle } = await import('@/workflows/thread-machine/workflow')
    await timedPhase('startLifecycle', () => start(threadMachineLifecycle, [actor, result.runId]))
    queuedRunId = null
    return { ...result, botId: input.botId, task: issue.title, status: 'queued' as const }
  } catch (error) {
    const { RunModelMissingError } = await import('@/lib/computer/run-model')
    // Nothing was queued: the run named no model, or the thread's own model and account no longer serve it.
    if (error instanceof RunModelMissingError) return { error: 'runModelMissing' as const, runId: error.runId, threadRunId: error.threadId }
    const { FactoryError } = await import('@/lib/factory/contract')
    if (error instanceof FactoryError) return { error: error.code }
    const { ComputerError } = await import('@/lib/computer/store')
    console.warn('cloud task dispatch refused', { error: error instanceof Error ? error.constructor.name : typeof error, code: error instanceof ComputerError ? error.status : undefined })
    if (input.threadRunId && error instanceof ComputerError && error.message === 'Bot subscription unavailable') return { error: 'threadModelUnavailable' as const, threadRunId: input.threadRunId }
    // E2B refused the thread machine: end the queued run so it is not left waiting on a machine that never starts.
    if (queuedRunId) await (await import('@/lib/cloud-computer/thread-machines')).threadMachineAction(pool, { userId, workspaceId: target.workspaceId }, queuedRunId, 'end').catch(() => undefined)
    return { error: 'cloudComputerUnavailable' }
  }
}

/** Start only an owned Bot's computer after workspace authorization. */
export async function wakeComputerBot(userId: string, input: { botId: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (!cloudComputerRunsEnabled()) return { error: 'cloudComputerUnavailable' }
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
  if (!cloudComputerRunsEnabled()) return { error: 'cloudComputerUnavailable' }
  const bot = (await pool.query('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2', [input.botId, userId])).rows[0]
  if (!bot) return { error: 'cloudComputerUnavailable' }
  try { await (await import('@/lib/subscription-runtime')).authorizeSubscriptionWorkspace(userId, bot.workspaceId) } catch { return { error: 'cloudComputerUnavailable' } }
  // The owner's subscriptions from any workspace: their own always work for their own bots (decision 2026-11-01-2240).
  const rows = (await pool.query(`SELECT id,provider,epoch FROM byos_connections WHERE "ownerId"=$1 AND state='connected' AND paused=false ORDER BY "createdAt",id LIMIT 50`, [userId])).rows
  return rows.map(row => ({ connectionId: row.id, provider: row.provider, revision: Number(row.epoch) }))
}

export async function bindComputerSubscription(userId: string, input: { botId: string; connectionId: string; revision: number; harness: 'codex' | 'claude_code'; modelId: string }, toolCallId: string, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId, scope)
  if (!cloudComputerRunsEnabled() || !toolCallId || toolCallId.length > 200) return { error: 'cloudComputerUnavailable' }
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
  if(scope?.scheduledRead)throw new FatalError('scheduleToolNotAllowed')
  await assertNativeToolScope(userId,scope)
  const { WRITE_TOOL_APPS } = await import('@/lib/app-policy/apps')
  const app = WRITE_TOOL_APPS[call.action]
  if (botId && app) {
    const { botMayUseApp } = await import('@/lib/app-policy/store')
    if (!(await botMayUseApp(botId, app))) return { error: 'integrationBlockedByWorkspace' }
  }
  const { personalWriteFromRun } = await import('@/lib/operations/write-runtime')
  return personalWriteFromRun(userId,botId,executionId,call,scope?.holder!==undefined?scope:undefined)
}
/** Durable personal intake; existing issue receipts recover a crash before routing. */
export async function intakeFactoryRequest(userId: string, input: import('@/lib/factory/intake').IntakeInput, scope: NativeToolScope | undefined, botId: string) {
  'use step'
  await assertNativeToolScope(userId, scope)
  return asToolResult(async () => {
    const { factoryForBot, factoryRequestSource } = await import('@/lib/factory/server')
    const { intakeRequest } = await import('@/lib/factory/intake')
    const store=factoryForBot(botId)
    return intakeRequest(input, {
      source:id=>factoryRequestSource(userId,botId,id),
      create:async(body,key)=>(await import('@/lib/mcp/actions')).createIssue(userId,body,systemActor(botId),key),
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


/** Scheduling is bound to a host-identified user message and its current chat. */
export async function scheduleCommand(userId:string,botId:string|null,sourceEventId:string|undefined,input:import('@/lib/schedules/contract').Command,scope?:NativeToolScope){
  'use step'
  await assertNativeToolScope(userId,scope)
  const {executeScheduleCommand}=await import('@/lib/schedules/runtime')
  return executeScheduleCommand(userId,botId,sourceEventId,input)
}
export async function assertScheduleRead(userId:string,botId:string,scope:import('@/lib/schedules/contract').ScheduledRead){
  'use step'
  const {assertScheduledRead}=await import('@/lib/schedules/runtime')
  await assertScheduledRead(userId,botId,scope)
}
export async function completeScheduleRead(userId:string,botId:string,scope:import('@/lib/schedules/contract').ScheduledRead,text:string,streamId?:string){
  'use step'
  const {schedules}=await import('@/lib/schedules/runtime')
  await schedules().completeRead(userId,botId,scope,text,streamId)
  return (await store.conversationForDisplay(userId,1,botId))[0]?.position ?? 0
}
export async function failScheduleRead(scope:import('@/lib/schedules/contract').ScheduledRead,denied=false){
  'use step'
  const {schedules}=await import('@/lib/schedules/runtime')
  const {ScheduleError}=await import('@/lib/schedules/contract')
  await schedules().fail({id:scope.occurrenceId,lease_token:scope.leaseToken},denied?new ScheduleError('scheduleReadAuthorityLost',403):new Error('scheduledReadFailed'))
}
