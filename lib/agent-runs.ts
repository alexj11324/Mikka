import { readRunFailure, type RunFailure } from '@mikka/protocol/run-failure'
import { readCompactRunFailure, runFailureBrief, type CompactRunFailure } from './run-failure-projection'
import 'server-only'
import { runDecisionWarnings, type ProjectDecisionWarning } from './project-decision-warnings'
import type { ExecutionIdentity } from './execution-identity'
import type { TeamScope } from './team-access'
import { personalMailboxEnabled } from './personal-mailbox-config'
import { byosEnabled } from './cloud-computer-flag'
import { snapshotMailboxTools } from '@/lib/personal-mailbox-capability'
import { freezeWorkerDefinition, type WorkerModelDispatch } from '@/lib/agent-kit/worker'
import type { AgentExecution } from '@/lib/agent-kit/store'
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { nativeRunBinding } from '@/lib/computer/native-run-binding'
import type { RunModel } from '@/lib/computer/run-model'
import { agents, agentRuns, bots, deviceRepos, devices, issues, runChunks, runMessages, type SupportedHarness } from '@/lib/db/schema'
import { ensureDeviceRepository } from '@/lib/device-repositories'
import { localExecutionHarnesses } from '@/lib/device-agents'
import { runWaitingDeviceId } from '@/lib/run-waiting-for'
import { deviceOnlineStates } from '@/lib/device-presence'
import { daemonTestMode, normalizeRepository } from '@mikka/protocol/repository'
import { issueVisibility, type IssueReader } from '@/lib/issue-visibility'
import { workspaceRunView } from '@/lib/run-visibility'
import { issueForUser } from '@/lib/issue-access'
import { tiptapToText } from '@/lib/tiptap-text'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { runPromptParts } from '@/lib/run-prompt'
import { dispatchInput, dispatchRequestKey, type DispatchInput, type DispatchResult } from '@/lib/run-dispatch'
import { agentProfileReferenceSchema, BUILTIN_AGENT_PROFILE_ID } from '@/lib/factory/agent-profile-reference'
import { sendOwnedRunMessage, stopOwnedRun } from '@/lib/run-control'
import { resolveStopTargets } from '@/lib/run-chain'
import { afterRunEnded } from '@/lib/run-completion-effects'
import { runBotName, threadNameHead } from '@/lib/run-bot-name'
import { requireTaskWorkspace } from '@/lib/task-workspace'

// Run operations for one person, by user id. The agent actions call these
// with the session's user; the Coordinator calls them with its owner's.

export type RunAgentProfile = Pick<NonNullable<RunModel['agentProfile']>, 'profileId' | 'name' | 'version' | 'digest' | 'source' | 'reason'>

export interface RunView {
  /** Public provenance only; never the private role instructions, skills or account reference. */
  agentProfile?: RunAgentProfile | null
  model?: string | null
  modelSource?: string | null
  /** Owner-only trusted provenance; omitted from workspace summaries and null on historical runs. */
  executionIdentity?: ExecutionIdentity | null
  id: string
  pauseReason?: 'human_control' | 'quota_exhausted' | null
  waitFor?: string
  issueId: string | null
  agentId: string
  /** The Bot that dispatched the run; `harness` is the Agent that executes it (R-78). */
  agentName: string
  harness: SupportedHarness
  status: string
  /** How it came out once it ended (R-52); null while running or not judged yet. */
  outcome?: string | null
  kind: string
  stopReason: string | null
  error: string | null
  /** Full diagnostics are owner-only; brief and teammate reads contain only compact fields. */
  failureDetails?: RunFailure | CompactRunFailure | null
  report: Record<string, unknown> | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

export interface RunDetail {
  decisionWarnings?: ProjectDecisionWarning[]
  run: RunView
  chunks: Record<string, unknown>[]
  messages: { id: string; text: string; createdAt: Date }[]
}

export const runViewColumns = {
  agentProfile: sql<RunAgentProfile | null>`case when ${agentRuns.agentDefinition}->'agentProfile' is null then null else jsonb_build_object(
    'profileId',${agentRuns.agentDefinition}->'agentProfile'->'profileId', 'name',${agentRuns.agentDefinition}->'agentProfile'->'name',
    'version',${agentRuns.agentDefinition}->'agentProfile'->'version', 'digest',${agentRuns.agentDefinition}->'agentProfile'->'digest',
    'source',${agentRuns.agentDefinition}->'agentProfile'->'source', 'reason',${agentRuns.agentDefinition}->'agentProfile'->'reason') end`,
  model: sql<string | null>`${agentRuns.agentDefinition}->>'model'`,
  modelSource: sql<string | null>`${agentRuns.agentDefinition}->>'modelSource'`,
  executionIdentity: sql<ExecutionIdentity | null>`${agentRuns.agentDefinition}->'executionIdentity'`,
  id: agentRuns.id, issueId: agentRuns.issueId, agentId: agentRuns.agentId, agentName: runBotName,
  harness: sql<SupportedHarness>`coalesce(${agentRuns.agentDefinition}->>'harness', ${agents.harness})`, status: agentRuns.status, outcome: agentRuns.outcome, pauseReason: agentRuns.pauseReason, kind: agentRuns.kind, stopReason: agentRuns.stopReason,
  error: agentRuns.error, report: agentRuns.report, failureDetails: agentRuns.failureDetails, createdAt: agentRuns.createdAt,
  startedAt: agentRuns.startedAt, finishedAt: agentRuns.finishedAt,
}

/**
 * `runViewColumns` for list reads (citations, the inbox): no provenance, the
 * report holds only its `summary` and the error only its first non-blank line,
 * exactly what `runSummaryText` reads from them.
 */
const { agentProfile: _profile, model: _model, modelSource: _modelSource, executionIdentity: _identity, ...runBriefColumns } = runViewColumns
const runBriefViewColumns = {
  ...runBriefColumns,
  failureDetails: runFailureBrief,
  report: sql<Record<string, unknown> | null>`case when jsonb_typeof(${agentRuns.report}) = 'object' then jsonb_build_object('summary', ${agentRuns.report}->'summary') end`,
  error: sql<string | null>`substring(${agentRuns.error} from '[^\\n]*\\S[^\\n]*')`,
}

/**
 * Queues one run of one agent against one issue. The daemon picks it up on its
 * next poll, claims it, and reports back through `/v1/runs/:runId/complete`.
 * `note` is extra direction for this run only, after the issue.
 */
/** `botId` is the bot that dispatched the run (null for the Coordinator); the run reports back to that bot's chat. */
type LocalDispatchInput = { issueId: string; agentId: string; repo: string; note?: string; requestKey?: string
  /** Required (lib/computer/run-model.ts): a new run's from 优先使用的模型, a thread's next run its own; never left to the CLI. */
  model: string
  /** The host's original selection policy, never inferred from the required model argument. */
  modelDispatch?: WorkerModelDispatch
  agentProfile?: RunModel['agentProfile']
  policyCeiling?: RunModel['policyCeiling']
  /** The run this one continues, named when the model is missing. */
  threadRunId?: string
  pinnedDeviceId?: string; readOnly?: boolean
  /** The API key the 优先使用的模型 entry names; the run uses it only when it may (lib/run-credential-source.ts). */
  apiKeyId?: string
  /** Exact server-selected identity; reauthorized for this owner, Agent and workspace at queue time. */
  subscriptionBindingId?: string }
export async function queueRun(userId: string, input: LocalDispatchInput, botId: string | null = null, execution?: AgentExecution, requestEventId?: string, source: 'mcp' | null = null) {
  return queueAdmittedRun(userId, input, botId, execution, requestEventId, source)
}

/** Only the Factory/Skill host calls this with an already-open transaction.
 * Repository ids identify prior scheduling metadata; they confer no authority. */
/** What the host already decided for a Factory run: its model and credential (lib/computer/run-model.ts), the computer it is pinned to, read-only. */
export type FactoryRunSelection = { threadRunId?: string; model?: string; subscriptionBindingId?: string; apiKeyId?: string; modelDispatch?: WorkerModelDispatch; agentProfile?: RunModel['agentProfile']; policyCeiling?: RunModel['policyCeiling']; pinnedDeviceId?: string; readOnly?: boolean; execution?: AgentExecution }
export async function queueFactoryRun(tx: import('pg').PoolClient, userId: string, input: DispatchInput,
  botId: string | null = null, context?: { sourceEventId: string; attemptId: string }, sourceRunId?: string, selection: FactoryRunSelection = {}): Promise<DispatchResult> {
  const parsed = dispatchInput.safeParse(input)
  if (!parsed.success || Boolean(context) === Boolean(sourceRunId)) throw new ActionFailureError('runInvalid')
  const { factoryDispatchDatabase } = await import('./factory/transaction')
  const executor = factoryDispatchDatabase(tx)
  return withDatabaseClient(tx, async () => {
    const [repo] = await executor.select().from(deviceRepos).where(and(eq(deviceRepos.id, parsed.data.deviceRepoId), eq(deviceRepos.userId, userId))).limit(1)
    if (!repo?.remoteUrl) throw new ActionFailureError('agentRepoMissing')
    let requestEventId: string | undefined
    let profileStage: string = 'execute'
    if (context) {
      const { rows: [event] } = await tx.query(`SELECT e.payload,a.stage FROM coordinator_events e
        JOIN factory_tasks t ON t."sourceEventId"=e.id AND t."userId"=e."userId" AND t."botId" IS NOT DISTINCT FROM e."botId"
        JOIN issues i ON i.id=t."issueId"
        JOIN factory_attempts a ON a."taskId"=t.id AND a.id=t."attemptId"
        WHERE e.id=$1 AND e."userId"=$2 AND (e."issueId" IS NULL OR e."issueId"=$3) AND e."botId" IS NOT DISTINCT FROM $4::uuid
          AND e.kind='user_message' AND t."issueId"=$3 AND a.id=$5 AND t.status NOT IN ('cancelled','revoked')
          AND i."ownershipState"='bound' AND t."workspaceId"=i."workspaceId"`, [context.sourceEventId, userId, parsed.data.issueId, botId, context.attemptId])
      if (!event) throw new ActionFailureError('runInvalid')
      profileStage = event.stage
      // The public Factory tool shares this queue with host-selected stages.
      // Only a stored user choice can select Default on the public path;
      // independent checks and frozen continuations keep the host's selection.
      if (!selection.model?.trim()) {
        const profile = agentProfileReferenceSchema.safeParse(event.payload?.profileId)
        if (profile.success && (profile.data === BUILTIN_AGENT_PROFILE_ID || parsed.data.profileId === BUILTIN_AGENT_PROFILE_ID)) parsed.data.profileId = profile.data
        else if (parsed.data.profileId === BUILTIN_AGENT_PROFILE_ID) throw new ActionFailureError('runInvalid')
      }
      // Even malformed destination data must reach the strict host-bound
      // admission check; an unbound ordinary chat request remains valid intake.
      if (Object.hasOwn(event.payload ?? {}, 'taskDestination')) requestEventId = context.sourceEventId
    } else if (sourceRunId) {
      const [source] = await executor.select().from(agentRuns).where(and(eq(agentRuns.id, sourceRunId), eq(agentRuns.userId, userId), eq(agentRuns.issueId, parsed.data.issueId), eq(agentRuns.agentId, parsed.data.agentId), eq(agentRuns.deviceRepoId, parsed.data.deviceRepoId))).limit(1)
      if (!source) throw new ActionFailureError('runInvalid')
      botId = source.botId
      requestEventId = source.agentDefinition?.repositoryAdmission?.requestEventId
    }
    // One place picks the model (lib/computer/run-model.ts): the host's choice, else a rerun's source run's own,
    // else 优先使用的模型 for this computer's Agent. A Factory run is never queued without one.
    const { execution, ...chosen } = selection
    const runModel = await factoryRunModel(userId, botId, parsed.data.agentId, chosen, sourceRunId
      ? (await executor.select({ agentDefinition: agentRuns.agentDefinition }).from(agentRuns).where(and(eq(agentRuns.id, sourceRunId), eq(agentRuns.userId, userId))).limit(1))[0]?.agentDefinition : null, parsed.data.profileId, profileStage, parsed.data.issueId, tx)
    const result = await queueAdmittedRun(userId, { ...parsed.data, ...runModel, threadRunId: selection.threadRunId ?? sourceRunId, ...(chosen.pinnedDeviceId ? { pinnedDeviceId: chosen.pinnedDeviceId } : {}), ...(profileStage === 'spec' || chosen.readOnly ? { readOnly: true } : {}), repo: repo.remoteUrl, requestKey: parsed.data.requestKey ?? (context ? `factory:${context.attemptId}` : undefined) }, botId, execution, requestEventId, null, { executor, repo, client: tx, sourceRunId, factoryContext: context })
    const [run] = await executor.select({ status: agentRuns.status }).from(agentRuns).where(and(eq(agentRuns.id, result.runId), eq(agentRuns.userId, userId))).limit(1)
    if (!run) throw new ActionFailureError('runInvalid')
    // BE-13: the target device cannot take the run right now -> one reason-coded event, same transaction.
    const { recordFactoryDispatchFailure } = await import('./factory/dispatch-recovery')
    await recordFactoryDispatchFailure(tx, userId, result.runId, context?.attemptId ?? null)
    return { runId: result.runId, status: run.status, replayed: result.replayed ?? false }
  })
}

/** Host-only provider recovery. The caller holds the source's Factory/issue/run
 * locks and commits its continuation receipt and frozen identity in this same
 * transaction. A different harness gets a new ordinary admission, never the
 * sourceRunId replay exception that is restricted to the original Agent. */
export async function queueProviderFallbackRun(tx: import('pg').PoolClient, userId: string, source: typeof agentRuns.$inferSelect,
  input: RunModel & { agentId: string; deviceRepoId: string }) {
  const invalid = () => new ActionFailureError('runInvalid', { reason: 'sourceRunMismatch' })
  if (source.userId !== userId || !source.issueId || !source.deviceRepoId || input.modelDispatch?.mode !== 'preference' ||
    Boolean(input.apiKeyId) === Boolean(input.subscriptionBindingId)) throw invalid()
  const { factoryDispatchDatabase } = await import('./factory/transaction')
  const executor = factoryDispatchDatabase(tx)
  return withDatabaseClient(tx, async () => {
    const [current] = await executor.select().from(agentRuns).where(and(eq(agentRuns.id, source.id), eq(agentRuns.userId, userId))).for('update')
    if (!current || current.issueId !== source.issueId || current.botId !== source.botId || current.deviceRepoId !== source.deviceRepoId ||
      current.status !== 'failed' || current.stopReason !== 'provider_failure' || current.stopRequestedAt || current.questionContinuation ||
      current.agentDefinition?.modelDispatch?.mode !== 'preference' || current.agentDefinition.modelDispatch.location === 'cloud') throw invalid()
    const [original] = await executor.select().from(deviceRepos).where(and(eq(deviceRepos.id, current.deviceRepoId!), eq(deviceRepos.userId, userId))).limit(1)
    const [repo] = await executor.select().from(deviceRepos).where(and(eq(deviceRepos.id, input.deviceRepoId), eq(deviceRepos.userId, userId))).limit(1)
    const [agent] = await executor.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.userId, userId))).limit(1)
    if (!original?.remoteUrl || original.deviceId !== current.deviceId || !repo?.remoteUrl || !agent?.deviceId || repo.deviceId !== agent.deviceId ||
      (current.agentDefinition.pinnedDeviceId && current.agentDefinition.pinnedDeviceId !== agent.deviceId)) throw invalid()
    const [device] = await executor.select({ kind: devices.kind }).from(devices).where(and(eq(devices.id, current.deviceId!), eq(devices.ownerId, userId))).limit(1)
    if (!device || (device.kind === 'cloud' && current.agentDefinition.allowLocalRecovery !== true)) throw invalid()
    try {
      const options = { allowFile: daemonTestMode(process.env) }
      if (normalizeRepository(original.remoteUrl, options).key !== normalizeRepository(repo.remoteUrl, options).key) throw invalid()
    } catch { throw invalid() }
    const { executionIdentitySchema } = await import('./execution-identity')
    const originalIdentity = executionIdentitySchema.safeParse(current.agentDefinition.executionIdentity)
    if (!originalIdentity.success || originalIdentity.data.requester !== userId || originalIdentity.data.executionPrincipal !== userId ||
      originalIdentity.data.outputOwner !== userId || originalIdentity.data.botId !== current.botId) throw new ActionFailureError('executionAccountUnavailable')
    const result = await queueAdmittedRun(userId, {
      ...input, issueId: current.issueId!, repo: repo.remoteUrl,
      requestKey: `provider:${current.id}`, pinnedDeviceId: current.agentDefinition.pinnedDeviceId,
      readOnly: current.agentDefinition.readOnly,
    }, current.botId, undefined, current.agentDefinition.repositoryAdmission?.requestEventId, current.source,
    // The wrapper authorizes the failed source above. All target policy,
    // credential, task-destination and publication checks still run normally.
    { executor, repo, client: tx, workspaceHint: originalIdentity.data.workspaceId })
    const [queued] = await executor.select({ definition: agentRuns.agentDefinition }).from(agentRuns).where(and(eq(agentRuns.id, result.runId), eq(agentRuns.userId, userId))).limit(1)
    const definition = queued?.definition
    if (!definition || definition.model !== input.model || (input.apiKeyId && definition.apiKey?.keyId !== input.apiKeyId) ||
      (input.subscriptionBindingId && definition.subscription?.bindingId !== input.subscriptionBindingId)) throw new ActionFailureError('executionAccountUnavailable')
    // The failed credential may already be disconnected or deleted. The new
    // admission authenticates its replacement; the requester's standing scope
    // must still equal the original host-frozen identity.
    const nextIdentity = executionIdentitySchema.safeParse(definition.executionIdentity)
    const standing = ['requester', 'executionPrincipal', 'outputOwner', 'botId', 'botOwner', 'workspaceId', 'personalResourcePolicy'] as const
    if (!nextIdentity.success || standing.some(field => originalIdentity.data[field] !== nextIdentity.data[field])) throw new ActionFailureError('executionAccountUnavailable')
    return result
  })
}

async function queueAdmittedRun(userId: string, input: Omit<LocalDispatchInput, 'model'> & { model?: string }, botId: string | null, execution?: AgentExecution,
  requestEventId?: string, source: 'mcp' | null = null,
  internal?: { executor: Pick<typeof db, 'select' | 'transaction'>; repo: typeof deviceRepos.$inferSelect; client: import('pg').PoolClient; sourceRunId?: string; workspaceHint?: string | null; factoryContext?: { sourceEventId: string; attemptId: string } }) {
  const executor = internal?.executor ?? db
  // Every local run is frozen with its model, a Factory or Skill run included: a caller that left it out fails here, before anything is read or written.
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.trim() === 'auto') {
    console.error(JSON.stringify({ msg: 'local_run_model_missing', threadRunId: input.threadRunId ?? null, issueId: input.issueId, agentId: input.agentId }))
    throw new ActionFailureError('runModelMissing')
  }
  const parsed = z.object({ issueId: z.uuid(), agentId: z.uuid(), repo: z.string().trim().min(1).max(4_000), note: z.string().trim().max(10_000).optional(), requestKey: dispatchRequestKey.optional(), model: z.string().trim().min(1).max(128).optional(), pinnedDeviceId: z.uuid().optional(), readOnly: z.boolean().optional(), apiKeyId: z.uuid().optional(), subscriptionBindingId: z.uuid().optional() }).refine(value => !(value.apiKeyId && value.subscriptionBindingId)).safeParse(input)
  if (!parsed.success) throw new ActionFailureError('runInvalid')
  try { normalizeRepository(parsed.data.repo, { allowFile: daemonTestMode(process.env) }) } catch { throw new ActionFailureError('repoPathInvalid') }
  const issue = await issueForUser(userId, parsed.data.issueId, false, executor)
  if (!issue || issue.ownershipState !== 'bound' || !issue.workspaceId) throw new ActionFailureError('issueNotFound')
  // A task already owns its tenant. A bot-less dispatch and a continuation
  // must use that tenant rather than the account's personal default.
  const workspaceId = issue.workspaceId
  if (internal?.workspaceHint && internal.workspaceHint !== workspaceId) throw new ActionFailureError('executionAccountUnavailable')
  const [agent] = await executor.select().from(agents)
    .where(and(eq(agents.id, parsed.data.agentId), eq(agents.userId, userId))).limit(1)
  if (!agent?.deviceId) throw new ActionFailureError('agentNoDevice')
  const [device] = await executor.select().from(devices).where(and(eq(devices.id, agent.deviceId), eq(devices.ownerId, userId), eq(devices.kind, 'local'))).limit(1)
  if (!device?.enabled || !localExecutionHarnesses(device.harnesses).includes(agent.harness)) throw new ActionFailureError('agentHarnessMissing')
  const repo = internal?.repo ?? await ensureDeviceRepository(userId, agent.deviceId, parsed.data.repo)
  const runId = crypto.randomUUID()
  const instructions = [agent.instructions, input.agentProfile?.instructions].filter(Boolean).join('\n\n')
  const { prompt, taskLength: promptTaskLength } = runPromptParts(issue.title, tiptapToText(issue.content), instructions, parsed.data.note)
  const captureDefinition = true
  const query = internal?.client ?? pool
  if (botId) {
    const botWorkspaceId = (await query.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2', [botId, userId])).rows[0]?.workspaceId
    if (!botWorkspaceId) throw new ActionFailureError('botNotFound')
    if (botWorkspaceId !== workspaceId) throw new ActionFailureError('runInvalid', { reason: 'botUnavailable' })
  }
  const found = captureDefinition && byosEnabled() ? await nativeRunBinding(query, userId, agent.id, agent.harness, workspaceId, parsed.data.subscriptionBindingId) : null
  if (parsed.data.subscriptionBindingId && (!found || (parsed.data.model && parsed.data.model !== found.modelId))) throw new ActionFailureError('executionAccountUnavailable')
  const model = parsed.data.subscriptionBindingId ? found?.modelId : parsed.data.model
  if (!model) throw new ActionFailureError('runModelMissing')
  // The run's credential, frozen now: the subscription, else the person's own API key (orchestration.md § 2).
  // A subscription's identity is its provider model, including at the CLI boundary.
  const { subscription, apiKey } = await localRunCredential(internal?.client ?? pool, userId, botId, workspaceId, agent.harness, parsed.data.subscriptionBindingId ? found?.modelId : model, found, parsed.data.apiKeyId)
  const mailboxEnabled = personalMailboxEnabled()
  let mailboxScope: { botId: string | null; workspaceId: string } | undefined
  if (captureDefinition && mailboxEnabled && snapshotMailboxTools(execution?.snapshot).length) {
    const [bot] = botId ? await executor.select({ workspaceId: bots.workspaceId }).from(bots)
      .where(and(eq(bots.id, botId), eq(bots.ownerId, userId))).limit(1) : []
    if (botId && !bot) throw new ActionFailureError('runInvalid')
    mailboxScope = { botId, workspaceId }
  }
  const agentDefinition = captureDefinition
    ? freezeWorkerDefinition({ harness: agent.harness, instructions, prompt, parent: execution?.snapshot ?? null, executionId: execution?.id ?? null,subscription, apiKey, model, modelDispatch: input.modelDispatch, agentProfile: input.agentProfile, policyCeiling: input.policyCeiling, pinnedDeviceId:parsed.data.pinnedDeviceId, mailboxEnabled, mailboxScope, readOnly: parsed.data.readOnly })
    : null
  if (agentDefinition && input.modelDispatch && !botId) {
    // Bot-less preferences belong to the actual execution workspace. Persist
    // that scope now so health/recovery never consult another workspace later.
    const { freezeExecutionIdentity, ExecutionIdentityError } = await import('./execution-identity')
    agentDefinition.executionIdentity = await freezeExecutionIdentity(query, { userId, botId, deviceId: agent.deviceId, agentDefinition }, undefined, workspaceId)
      .catch(error => { if (error instanceof ExecutionIdentityError) throw new ActionFailureError('executionAccountUnavailable'); throw error })
  }
  return (await import('@/lib/run-admission-store')).acceptLocalRun({ id: runId, userId, botId, issueId: issue.id, agentId: agent.id, deviceId: agent.deviceId,
    deviceRepoId: repo.id, prompt, promptTaskLength, source, definition: agentDefinition!, profileSourceRunId: input.threadRunId, factoryContext: internal?.factoryContext, ...(requestEventId ? { requestEventId } : {}), ...(parsed.data.requestKey ? { dispatch: { issueId: issue.id, agentId: agent.id, deviceRepoId: repo.id, note: parsed.data.note, requestKey: parsed.data.requestKey, ...(parsed.data.subscriptionBindingId ? { subscriptionBindingId: parsed.data.subscriptionBindingId } : {}) } } : {}), ...(internal ? { continuation: true, sourceRunId: internal.sourceRunId } : {}) }, internal?.client)
}

/** A Factory run's model: the host's choice; else a rerun's source run's own; else 优先使用的模型 for the Agent's computer. */
async function factoryRunModel(userId: string, botId: string | null, agentId: string, chosen: Omit<FactoryRunSelection, 'execution' | 'pinnedDeviceId' | 'readOnly'>,
  source: Parameters<typeof import('@/lib/computer/run-model').threadRunModel>[0], profileId?: string, stage: string = 'execute', issueId?: string, transaction?: import('pg').PoolClient) {
  const { threadRunModel } = await import('@/lib/computer/run-model')
  if (profileId && chosen.model && chosen.agentProfile?.profileId !== profileId) throw new ActionFailureError('runInvalid')
  if (chosen.model?.trim()) return { model: chosen.model, ...(chosen.subscriptionBindingId ? { subscriptionBindingId: chosen.subscriptionBindingId } : {}), ...(chosen.apiKeyId ? { apiKeyId: chosen.apiKeyId } : {}), ...(chosen.modelDispatch ? { modelDispatch: chosen.modelDispatch } : {}), ...(chosen.agentProfile ? { agentProfile: chosen.agentProfile } : {}), ...(chosen.policyCeiling ? { policyCeiling: chosen.policyCeiling } : {}) }
  const kept = threadRunModel(source)
  if (kept) {
    if (profileId && kept.agentProfile?.profileId !== profileId) throw new ActionFailureError('runInvalid')
    return kept
  }
  const [agent] = await db.select({ id: agents.id, deviceId: agents.deviceId, harness: agents.harness }).from(agents).where(and(eq(agents.id, agentId), eq(agents.userId, userId))).limit(1)
  if (!agent?.deviceId || (agent.harness !== 'codex' && agent.harness !== 'claude_code')) throw new ActionFailureError('runModelMissing')
  const task = issueId ? await issueForUser(userId, issueId) : null
  const workspaceId = task?.workspaceId
  if (!workspaceId || task?.ownershipState !== 'bound') throw new ActionFailureError('runModelMissing')
  if (botId) {
    const botWorkspaceId = await (await import('@/lib/execution-settings')).executionWorkspace(userId, botId).catch(() => null)
    if (botWorkspaceId !== workspaceId) throw new ActionFailureError('runInvalid', { reason: 'botUnavailable' })
  }
  const { target, agentProfile, selectionMode } = await (await import('@/lib/factory/agent-profile')).resolveAgentProfileDispatch(pool,
    { ownerId: userId, workspaceId, botId }, { issueId: issueId!, stage, profileId, agentId: agent.id, deviceId: agent.deviceId, location: 'local', asked: { harness: agent.harness } }, { transaction })
  if (target.kind !== 'device' || target.agentId !== agent.id) throw new ActionFailureError('runModelMissing')
  return { model: target.model, agentProfile,
    modelDispatch: { mode: selectionMode ?? 'preference', location: 'local' as const, entry: target.entry, ...(target.routing ? { routing: target.routing } : {}) },
    ...(target.subscriptionBindingId ? { subscriptionBindingId: target.subscriptionBindingId } : {}),
    ...(target.entry.source.kind === 'api_key' ? { apiKeyId: target.entry.source.keyId } : {}),
    ...(chosen.policyCeiling ? { policyCeiling: chosen.policyCeiling } : {}) }
}

/** A device run's credential source; the bot's workspace decides whose API keys it may use. */
async function localRunCredential<S extends { id: string; ownerId: string; connectionId: string; connectionRevision: number }>(query: import('pg').Pool | import('pg').PoolClient,
  userId: string, botId: string | null, workspaceId: string, harness: string, model: string | undefined, subscription: S | null, keyId?: string) {
  return (await import('@/lib/run-credential-source')).runCredentialSource(query, { ownerId: userId, botId, harness, model, keyId,
    botWorkspaceId: botId ? workspaceId : null, choiceWorkspaceId: workspaceId, subscription, localLogin: true })
}

/** Which runs `userId` may see: their own (on no task or a visible task) and teammates' runs on shared visible tasks. */
async function runVisibilityPredicate(reader: IssueReader, input: { issueId?: string; runIds?: string[]; teams?: readonly TeamScope[] }) {
  const userId = typeof reader === 'string' ? reader : reader.id
  // The persisted run/task tenant and fresh reader authority decide access.
  // Team links only name tasks; no run-to-task pre-read is needed for this gate.
  const visibility = await issueVisibility(reader, false, undefined, db, { teams: input.teams, withTeamLinks: false })
  const tenant = visibility.workspaceIds.length ? inArray(agentRuns.workspaceId, visibility.workspaceIds) : sql`false`
  const task = and(visibility.predicate, eq(agentRuns.workspaceId, issues.workspaceId))
  // Task-bound runs use the exact same Task gate for every reader. Factoring
  // it once avoids sending and evaluating the full recursive ACL twice.
  return and(tenant, or(and(eq(agentRuns.userId, userId), isNull(agentRuns.issueId)), task))
}

/**
 * The cited runs' names only (the bot list's preview line, `namedCitations`):
 * the same visibility as `visibleRuns`, with each own run's prompt cut to what
 * `threadName` reads (`threadNameHead`), and a teammate's run named by its harness
 * as `workspaceRunView` does. No report, error or provenance.
 */
export async function visibleRunNames(reader: IssueReader, runIds: string[], teams?: readonly TeamScope[]): Promise<{ id: string; own: boolean; agentName: string; harness: string; promptHead: string | null }[]> {
  const userId = typeof reader === 'string' ? reader : reader.id
  if (!runIds.length || runIds.some(id => !z.uuid().safeParse(id).success)) return []
  const visible = await runVisibilityPredicate(reader, { runIds, teams })
  const rows = await db.select({ id: agentRuns.id, ownerId: agentRuns.userId, agentName: runBotName, harness: runViewColumns.harness,
    promptHead: sql<string | null>`case when agent_runs."userId" = ${userId} then ${threadNameHead} end` }).from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(and(visible, inArray(agentRuns.id, runIds))).limit(Math.max(1, Math.min(runIds.length, 100)))
  return rows.map(({ ownerId, ...row }) => ({ ...row, own: ownerId === userId }))
}

/** Every surface uses this gate. Workspace membership never grants run control,
 * personal agent/session access, or raw transcript access.
 * `brief`: the list projection (`runBriefViewColumns`), for callers that show a run's name, state and summary only. */
export async function visibleRuns(reader: IssueReader, input: { issueId?: string; runIds?: string[]; activeOnly?: boolean; limit?: number; brief?: boolean; teams?: readonly TeamScope[] } = {}): Promise<RunView[]> {
  const userId = typeof reader === 'string' ? reader : reader.id
  if (input.issueId && !z.uuid().safeParse(input.issueId).success) return []
  if (input.runIds && (!input.runIds.length || input.runIds.some(id => !z.uuid().safeParse(id).success))) return []
  const visible = await runVisibilityPredicate(reader, input)
  const rows = await db.select({ ...(input.brief ? runBriefViewColumns : runViewColumns),
    failureDetails: input.brief ? runFailureBrief : sql<RunFailure | CompactRunFailure | null>`case when ${agentRuns.userId}=${userId} then ${agentRuns.failureDetails} else ${runFailureBrief} end`, ownerId: agentRuns.userId, waitDeviceId: agentRuns.deviceId, lastSeenAt:devices.lastSeenAt, deviceEnabled:devices.enabled }).from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(issues, eq(issues.id, agentRuns.issueId)).leftJoin(devices,eq(devices.id,agentRuns.deviceId))
    .where(and(
      visible,
      input.issueId ? eq(agentRuns.issueId, input.issueId) : undefined,
      input.runIds ? inArray(agentRuns.id, input.runIds) : undefined,
      input.activeOnly ? inArray(agentRuns.status, [...UNFINISHED_RUN_STATUSES]) : undefined,
    )).orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(Math.max(1, Math.min(input.limit ?? 20, 100)))
  const presence = await deviceOnlineStates(rows.flatMap(row => row.ownerId === userId && row.status === 'queued' && row.waitDeviceId
    ? [{ id: row.waitDeviceId, lastSeenAt: row.lastSeenAt }] : []))
  return rows.map(({ ownerId, waitDeviceId, lastSeenAt, deviceEnabled, ...run }) => {
    const waitFor = runWaitingDeviceId(userId, { ownerId, status: run.status, deviceId: waitDeviceId, lastSeenAt, deviceEnabled, deviceOnline: waitDeviceId ? presence.get(waitDeviceId) : undefined })
    return ownerId === userId ? { ...run, failureDetails: input.brief ? readCompactRunFailure(run.failureDetails) : readRunFailure(run.failureDetails), ...(waitFor ? { waitFor } : {}) } : workspaceRunView(run)
  })
}

export async function readRun(userId: string, runId: string): Promise<RunDetail | null> {
  const [run] = await visibleRuns(userId, { runIds: [runId], limit: 1 })
  if (!run) return null
  // Empty agentId is the deliberately restricted teammate projection.
  if (!run.agentId) return { run, chunks: [], messages: [] }
  const chunks = await db.select({ chunk: runChunks.chunk }).from(runChunks)
    .where(eq(runChunks.runId, run.id)).orderBy(asc(runChunks.seq))
  const messages = await db.select({ id: runMessages.id, text: runMessages.text, createdAt: runMessages.createdAt })
    .from(runMessages).where(eq(runMessages.runId, run.id)).orderBy(asc(runMessages.createdAt))
  const decisionWarnings = await runDecisionWarnings(pool, userId, run.id)
  return { run, chunks: chunks.map(row => row.chunk), messages, decisionWarnings }
}

/** A message to the running agent; the daemon delivers it. */
export async function addRunMessage(
  userId: string,
  input: { runId: string; text: string },
  source:'user'|'peer'|{source:'human';sessionId:string}|{source:'orchestrator'}='user',
  messageId?: string,
): Promise<void> {
  const parsed = z
    .object({ runId: z.uuid(), text: z.string().trim().min(1).max(10_000) })
    .safeParse(input)
  if (!parsed.success) throw new ActionFailureError('messageRequired')
  const [authorized] = await db.select({ workspaceId: agentRuns.workspaceId }).from(agentRuns)
    .where(and(eq(agentRuns.id, parsed.data.runId), eq(agentRuns.userId, userId))).limit(1)
  if (!authorized?.workspaceId) throw new ActionFailureError('runNotFound')
  await requireTaskWorkspace(userId, authorized.workspaceId)
  // Ordinary user/peer traffic keeps main's single locked owner/state check.
  // Only a host-attested browser session may enter ended Factory questions.
  if (typeof source === 'string' || source.source === 'orchestrator')
    return sendOwnedRunMessage(db,userId,{...parsed.data,...(messageId ? {messageId} : {})},typeof source === 'string' ? source : 'peer')
  const [run] = await db
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.id, parsed.data.runId), eq(agentRuns.userId, userId)),
    )
    .limit(1)
  if (!run) throw new ActionFailureError('runNotFound')
  if (
    !['queued', 'preparing', 'running', 'waiting_input', 'finishing'].includes(
      run.status,
    )
  ) {
    const { factoryRuntimeForBot } = await import('@/lib/factory/runtime')
    const { pool } = await import('@/lib/db')
    const {
      rows: [identity],
    } = await pool.query(
      `SELECT q.id,t."botId" FROM factory_questions q JOIN factory_tasks t ON t.id=q."taskId"
       WHERE q."originRunId"=$1 AND q."userId"=$2 AND t."userId"=$2`,
      [run.id, userId],
    )
    if (!identity) throw new ActionFailureError('runNotActive')
    // The task owns this scope. A worker can also belong to a Bot when its
    // legacy Factory task is unscoped; neither the caller nor worker chooses it.
    const factoryQuestions = factoryRuntimeForBot(identity.botId).questions
    const q = await factoryQuestions.read(userId, identity.id)
    if (q.status === 'resolved' && q.continuationRunId) {
      const previous = q.answer as {
        input?: { text?: string; reference?: unknown }
      } | null
      if (previous?.input?.text !== parsed.data.text)
        return addRunMessage(
          userId,
          { runId: q.continuationRunId, text: parsed.data.text },
          source,
          messageId,
        )
    }
    if (typeof source==='string' || source.source !== 'human')
      throw new ActionFailureError('factoryQuestionNeedsAnswerTool')
    const { factoryEventId } = await import('@/lib/factory/event-id')
    const { questionReference } = await import('@/lib/factory/questions/store')
    const { questionFingerprint } =
      await import('@/lib/factory/questions/contract')
    const previous = q.answer as {
      input?: { reference?: ReturnType<typeof questionReference> }
    } | null
    const answerId = factoryEventId(
      'task-thread-question-answer',
      questionFingerprint({ questionId: q.id, userId, text: parsed.data.text }),
    )
    await factoryQuestions.answer(
      { source: 'human', userId, sessionId: source.sessionId },
      {
        reference:
          q.answerId === answerId && previous?.input?.reference
            ? previous.input.reference
            : questionReference(q),
        answerId,
        text: parsed.data.text,
      },
    )
    return
  }
  await sendOwnedRunMessage(db,userId,{...parsed.data,...(messageId ? {messageId} : {})},typeof source==='string'?source:source.source==='human'?'user':'peer')
}
/** Asks the daemon to stop the run; it repeats until the run has ended. */
export async function requestRunStop(userId: string, runId: string): Promise<{ stoppedRunIds: string[] }> {
  const parsed = z.uuid().safeParse(runId)
  if (!parsed.success) throw new ActionFailureError('runNotFound')
  const [authorized] = await db.select({ workspaceId: agentRuns.workspaceId }).from(agentRuns)
    .where(and(eq(agentRuns.id, parsed.data), eq(agentRuns.userId, userId))).limit(1)
  if (!authorized?.workspaceId) throw new ActionFailureError('runNotFound')
  await requireTaskWorkspace(userId, authorized.workspaceId)
  // BE-18 (Tech Lead): stop acts on the requested run and every later attempt of its chain
  // (question continuations and retryOf reruns, same owner + issue only; lib/run-chain.ts).
  // Each still-unfinished one is stopped; a queued one ends here, so it is finalized with
  // afterRunEnded under its own runId (#467). If nothing from the requested run onward is
  // unfinished, it is a 409 runChainEnded with latestRunId — never a silent no-op. A run that
  // ends between the read and its stop is skipped; if that leaves nothing stopped it is also
  // runChainEnded. A continuation created after the chain was read is not stopped: accepted window.
  const target = await resolveStopTargets(pool, userId, parsed.data)
  if (target.kind === 'notFound') throw new ActionFailureError('runNotFound')
  if (target.kind === 'chainEnded') throw new ActionFailureError('runChainEnded', { latestRunId: target.latestRunId })
  const stoppedRunIds: string[] = []
  for (const runId of target.runIds) {
    try {
      if (await stopOwnedRun(db, userId, runId)) await afterRunEnded(userId, runId)
      else {
        // A refused startup may have no lifecycle/daemon to acknowledge this
        // stop. Reuse the scoped host acknowledgement after the stop commits.
        const binding = (await pool.query('SELECT "workspaceId" FROM computer_run_bindings WHERE "runId"=$1 AND "ownerId"=$2', [runId, userId])).rows[0]
        if (binding) await (await import('@/lib/cloud-computer/thread-machines')).acknowledgeQueuedThreadStop(pool, { userId, workspaceId: binding.workspaceId }, runId)
      }
      stoppedRunIds.push(runId)
    } catch (error) {
      if (!(error instanceof ActionFailureError && error.code === 'runNotFound')) throw error
    }
  }
  if (!stoppedRunIds.length) throw new ActionFailureError('runChainEnded', { latestRunId: target.latestRunId })
  return { stoppedRunIds }
}
