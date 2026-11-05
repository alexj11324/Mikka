import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import type { WorkerDefinitionSnapshot } from '@/lib/agent-kit/worker'
import { assertProfileTarget, assertProfileSelection, BUILTIN_AGENT_PROFILE_ID, isBuiltinAgentProfileSelection, type AgentProfileSelection } from './agent-profile'

import { watchdogProfileAdmission, watchdogProfileClaimContext, type ProfileFactoryContext } from './profile-watchdog'

type Query = Pick<Pool | PoolClient, 'query'>
export class AgentProfileAdmissionError extends Error {
  constructor() { super('agentProfileUnavailable'); this.name = 'AgentProfileAdmissionError' }
}

/** Runtime/publication preparation can outlive a quota observation. Refresh
 * only the already selected binding before the admission transaction. This is
 * not admission: the existing transaction still checks current authority and
 * decides whether an established native session keeps its frozen role. */
export async function refreshProfileQuota(pool: Pool, input: {
  ownerId: string; workspaceId: string; agentId: string; model?: string
  subscriptionBindingId?: string | null; selection?: AgentProfileSelection
}): Promise<void> {
  const selection = input.selection, entry = selection?.targetEntry
  if (!selection || selection.scope?.ownerId !== input.ownerId || selection.scope?.workspaceId !== input.workspaceId ||
    !entry || entry.source?.kind !== 'subscription' || entry.model !== input.model || !input.subscriptionBindingId) return
  const { nativeRunBinding } = await import('@/lib/computer/native-run-binding')
  const binding = await nativeRunBinding(pool, input.ownerId, input.agentId, entry.harness, input.workspaceId, input.subscriptionBindingId)
  if (!binding || binding.connectionId !== entry.source.connectionId || binding.modelId !== entry.model) return
  const { credentialStates, orderCandidates } = await import('@/lib/model-order')
  const scope = { ownerId: input.ownerId, workspaceId: input.workspaceId }
  await credentialStates(pool, scope, [entry], await orderCandidates(pool, scope))
}

/** A host-supplied source is an exception only for the exact frozen role of an
 * already-started, owned native session. A JSON flag can never grant it. */
export async function admitProfileSelection(query: Query, input: {
  ownerId: string; workspaceId: string; issueId: string; harness: string
  selection?: AgentProfileSelection; sourceRunId?: string; model?: string; apiKeyId?: string; subscriptionBindingId?: string
  factoryContext?: ProfileFactoryContext
}): Promise<string | undefined> {
  if (input.selection) {
    if ((input.selection.profileId === BUILTIN_AGENT_PROFILE_ID || input.selection.source === 'default') && (!isBuiltinAgentProfileSelection(input.selection) || input.selection.scope.ownerId !== input.ownerId || input.selection.scope.workspaceId !== input.workspaceId)) throw new AgentProfileAdmissionError()
    const entry = input.selection.targetEntry
    if (entry.harness !== input.harness || entry.model !== input.model) throw new AgentProfileAdmissionError()
    if (entry.source.kind === 'api_key') {
      if (input.apiKeyId !== entry.source.keyId || input.subscriptionBindingId) throw new AgentProfileAdmissionError()
    } else {
      if (!input.subscriptionBindingId || input.apiKeyId) throw new AgentProfileAdmissionError()
      const bound = await query.query('SELECT 1 FROM byos_bindings WHERE id=$1 AND "connectionId"=$2 AND "modelId"=$3 AND "workspaceId"=$4',
        [input.subscriptionBindingId, entry.source.connectionId, input.model, input.workspaceId])
      if (!bound.rowCount) throw new AgentProfileAdmissionError()
    }
  }
  if (input.selection && input.sourceRunId && input.factoryContext) {
    const watchdog = await watchdogProfileAdmission(query, { ...input, sourceRunId: input.sourceRunId }, input.factoryContext)
    if (watchdog === 'invalid' || (watchdog === 'none' && input.factoryContext.runId)) throw new AgentProfileAdmissionError()
    if (watchdog === 'started' || watchdog === 'unstarted') {
      try {
        // A started task keeps its exact role, while B's live source is checked
        // again. An unstarted selection must still match the editable head.
        await (watchdog === 'started' ? assertProfileTarget : assertProfileSelection)(query,
          { ownerId: input.ownerId, workspaceId: input.workspaceId }, input.selection!)
      } catch { throw new AgentProfileAdmissionError() }
      return undefined // A different executor receives no native-origin grant.
    }
  }
  if (input.sourceRunId) {
    const { rows: [source] } = await query.query<{ agentDefinition: WorkerDefinitionSnapshot; startedAt: Date | null; sessionId: string | null; status: string; stopReason: string | null; stopRequestedAt: Date | null }>(
      `SELECT "agentDefinition","startedAt","sessionId",status,"stopReason","stopRequestedAt" FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3
        AND "agentDefinition"->'executionIdentity'->>'workspaceId'=$4 FOR SHARE`,
      [input.sourceRunId, input.ownerId, input.issueId, input.workspaceId])
    if (source?.agentDefinition?.agentProfile) {
      const same = input.selection && isDeepStrictEqual(source.agentDefinition.agentProfile, input.selection) &&
        source.agentDefinition.harness === input.harness && source.agentDefinition.model === input.model &&
        source.agentDefinition.subscription?.bindingId === input.subscriptionBindingId && source.agentDefinition.apiKey?.keyId === input.apiKeyId
      const unclaimedStartup = input.selection && source.status === 'failed' && source.stopReason === 'device_lost' &&
        !source.startedAt && !source.sessionId && !source.stopRequestedAt &&
        isDeepStrictEqual({ ...source.agentDefinition.agentProfile, targetEntry: undefined }, { ...input.selection, targetEntry: undefined })
      if (!same && !unclaimedStartup && (!input.selection || !isBuiltinAgentProfileSelection(input.selection) || !isBuiltinAgentProfileSelection(source.agentDefinition.agentProfile))) throw new AgentProfileAdmissionError()
      // An unclaimed failed startup may retry the same role on a newly
      // authorized target. This is fresh admission, not a native continuation.
      // A legacy/default thread can make a fresh authorized model selection.
      // A changed model or source never inherits the old native-session grant.
      if (same && source.startedAt && source.sessionId) return input.sourceRunId
    }
  }
  if (!input.selection) return undefined
  try { await assertProfileSelection(query, { ownerId: input.ownerId, workspaceId: input.workspaceId }, input.selection) }
  catch { throw new AgentProfileAdmissionError() }
  return undefined
}

/** Queued new selections must still be current at the first claim. A resumed
 * native session keeps its admitted role; resource revocation is independently
 * checked by the existing execution-identity and credential gates. */
export async function assertRunProfileClaim(query: Query, runId: string) {
  const { rows: [run] } = await query.query<typeof import('@/lib/db/schema').agentRuns.$inferSelect>(
    'SELECT * FROM agent_runs WHERE id=$1', [runId])
  const definition = run?.agentDefinition
  if (!definition?.agentProfile) return
  const workspaceId = definition.executionIdentity?.workspaceId
  if (!workspaceId || !run.issueId) throw new AgentProfileAdmissionError()
  if ((definition.agentProfile.profileId === BUILTIN_AGENT_PROFILE_ID || definition.agentProfile.source === 'default') && (!isBuiltinAgentProfileSelection(definition.agentProfile) || definition.agentProfile.scope.ownerId !== run.userId || definition.agentProfile.scope.workspaceId !== workspaceId)) throw new AgentProfileAdmissionError()
  if (run.questionContinuation && run.kind === 'implement') {
    const { rows: [task] } = await query.query(`SELECT t.* FROM factory_tasks t
      JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id AND a."runId"=$1
      JOIN factory_questions q ON q."taskId"=t.id AND q."continuationRunId"=a."runId" AND q."userId"=t."userId" AND q."issueId"=t."issueId"
      WHERE t."userId"=$2 AND t."issueId"=$3 AND t.stage='execute' AND t.status='running' AND a.status='running'
        AND q.status='resuming' AND (q."expiresAt" IS NULL OR q."expiresAt">clock_timestamp()) FOR SHARE OF t,a,q`, [run.id,run.userId,run.issueId])
    const edge = task ? await (await import('./questions/execution-continuation')).questionExecutionContinuation(query,task,task.attemptId) : null
    if (!edge || run.stopRequestedAt || run.status !== 'queued') throw new AgentProfileAdmissionError()
    const source = await admitProfileSelection(query, { ownerId: run.userId, workspaceId, issueId: run.issueId,
      harness: definition.harness, model: definition.model, apiKeyId: definition.apiKey?.keyId,
      subscriptionBindingId: definition.subscription?.bindingId, selection: definition.agentProfile, sourceRunId: edge.questionOriginRunId })
    if (source !== edge.questionOriginRunId) throw new AgentProfileAdmissionError()
    return
  }
  // Provider recovery gets a fresh native session, with the old role and a
  // newly authorized model. Only its committed host receipt grants this path.
  const { rows: [providerSource] } = run.retryOf
    ? await query.query<typeof import('@/lib/db/schema').agentRuns.$inferSelect>('SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR SHARE', [run.retryOf, run.userId, run.issueId])
    : await query.query<typeof import('@/lib/db/schema').agentRuns.$inferSelect>(`SELECT * FROM agent_runs WHERE "userId"=$1 AND "issueId"=$2
        AND "stopReason"='provider_failure' AND report->'modelFallback'->>'retryRunId'=$3 ORDER BY "createdAt" DESC LIMIT 1 FOR SHARE`, [run.userId, run.issueId, run.id])
  const watchdog = await watchdogProfileClaimContext(query, { id: run.id, userId: run.userId, issueId: run.issueId })
  if (watchdog) {
    if (!run.retryOf) throw new AgentProfileAdmissionError()
    await admitProfileSelection(query, { ownerId: run.userId, workspaceId, issueId: run.issueId,
      harness: definition.harness, model: definition.model, apiKeyId: definition.apiKey?.keyId,
      subscriptionBindingId: definition.subscription?.bindingId, selection: definition.agentProfile,
      sourceRunId: run.retryOf, factoryContext: watchdog })
    return
  }
  // Independent Factory checks deliberately clear retryOf and native SID.
  // Their exact current task/candidate/stage event is the recovery authority.
  if (providerSource?.agentDefinition?.agentProfile) {
    const { providerContinuationLaunchMatches } = await import('@/lib/run-provider-fallback')
    if (await providerContinuationLaunchMatches(query, providerSource, run)) return
  }
  await admitProfileSelection(query, { ownerId: run.userId, workspaceId, issueId: run.issueId,
    harness: definition.harness, model: definition.model, apiKeyId: definition.apiKey?.keyId, subscriptionBindingId: definition.subscription?.bindingId, selection: definition.agentProfile, sourceRunId: definition.profileOriginRunId })
}
