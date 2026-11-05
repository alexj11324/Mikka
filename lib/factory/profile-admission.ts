import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import { CodedError, type CodedErrorOptions } from '@mikka/protocol/coded-error'
import type { Pool, PoolClient } from 'pg'
import type { WorkerDefinitionSnapshot } from '@/lib/agent-kit/worker'
import { MODEL_ROUTING_TIERS, modelTier } from '@/lib/model-routing'
import { credentialStates, orderCandidates } from '@/lib/model-order'
import { executionIdentityForRun, ExecutionIdentityError } from '@/lib/execution-identity'
import { assertProfileTarget, assertProfileSelection, BUILTIN_AGENT_PROFILE_ID, isBuiltinAgentProfileSelection, type AgentProfileSelection } from './agent-profile'

import { watchdogProfileAdmission, watchdogProfileClaimContext, type ProfileFactoryContext } from './profile-watchdog'

type Query = Pick<Pool | PoolClient, 'query'>
export type AgentProfileAdmissionDetail =
  | 'scope_unavailable' | 'snapshot_invalid' | 'target_mismatch' | 'credential_mismatch' | 'binding_unavailable'
  | 'watchdog_receipt' | 'watchdog_target' | 'continuation_mismatch' | 'current_profile' | 'question_receipt' | 'question_origin'
export class AgentProfileAdmissionError extends CodedError<'agentProfileUnavailable', AgentProfileAdmissionDetail> {
  constructor(options?: CodedErrorOptions<AgentProfileAdmissionDetail>) {
    super('agentProfileUnavailable', options)
    this.name = 'AgentProfileAdmissionError'
    // Keep the existing public contract; the closed detail and original cause
    // are available to structured diagnostics without exposing private input.
    this.message = 'agentProfileUnavailable'
  }
}

/** Runtime startup can outlive the queue's quota snapshot. Refresh only this
 * queued run's frozen subscription before taking claim/source locks. This is
 * not admission: the original locked checks still decide, even after failure.
 * Existing native-session grants and API-key runs need no new usage probe. */
export async function refreshCloudRunProfileClaim(pool: Pool, actor: { userId: string; workspaceId: string }, runId: string, deviceId: string, subscriptionBindingId: string | null): Promise<void> {
  if (!subscriptionBindingId) return
  const { rows: [run] } = await pool.query<typeof import('@/lib/db/schema').agentRuns.$inferSelect>(
    `SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3 AND status='queued' AND "stopRequestedAt" IS NULL
      AND "agentDefinition"->'executionIdentity'->>'workspaceId'=$4`, [runId, actor.userId, deviceId, actor.workspaceId])
  const definition = run?.agentDefinition, selection = definition?.agentProfile, entry = selection?.targetEntry
  if (!run || !definition || !selection || !entry || entry.source.kind !== 'subscription' || definition.profileOriginRunId || run.questionContinuation) return
  if (selection.scope.ownerId !== actor.userId || selection.scope.workspaceId !== actor.workspaceId || entry.harness !== definition.harness || entry.model !== definition.model || definition.apiKey || definition.subscription?.bindingId !== subscriptionBindingId) return
  try { await executionIdentityForRun(pool, runId, actor.userId) }
  catch (error) { if (error instanceof ExecutionIdentityError) return; throw error }
  const bound = await pool.query('SELECT 1 FROM byos_bindings WHERE id=$1 AND "connectionId"=$2 AND "modelId"=$3 AND "workspaceId"=$4',
    [subscriptionBindingId, entry.source.connectionId, entry.model, actor.workspaceId])
  if (!bound.rowCount) return
  const scope = { ownerId: actor.userId, workspaceId: actor.workspaceId }
  const candidates = await orderCandidates(pool, scope)
  await credentialStates(pool, scope, [entry], candidates, undefined, { probe: 'always' })
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
    if ((input.selection.profileId === BUILTIN_AGENT_PROFILE_ID || input.selection.source === 'default') && (!isBuiltinAgentProfileSelection(input.selection) || input.selection.scope.ownerId !== input.ownerId || input.selection.scope.workspaceId !== input.workspaceId)) throw new AgentProfileAdmissionError({ detail: 'snapshot_invalid' })
    const entry = input.selection.targetEntry
    if (entry.harness !== input.harness || entry.model !== input.model) throw new AgentProfileAdmissionError({ detail: 'target_mismatch' })
    if (entry.source.kind === 'api_key') {
      if (input.apiKeyId !== entry.source.keyId || input.subscriptionBindingId) throw new AgentProfileAdmissionError({ detail: 'credential_mismatch' })
    } else {
      if (!input.subscriptionBindingId || input.apiKeyId) throw new AgentProfileAdmissionError({ detail: 'credential_mismatch' })
      const bound = await query.query('SELECT 1 FROM byos_bindings WHERE id=$1 AND "connectionId"=$2 AND "modelId"=$3 AND "workspaceId"=$4',
        [input.subscriptionBindingId, entry.source.connectionId, input.model, input.workspaceId])
      if (!bound.rowCount) throw new AgentProfileAdmissionError({ detail: 'binding_unavailable' })
    }
  }
  if (input.selection && input.sourceRunId && input.factoryContext) {
    const watchdog = await watchdogProfileAdmission(query, { ...input, sourceRunId: input.sourceRunId }, input.factoryContext)
    if (watchdog === 'invalid' || (watchdog === 'none' && input.factoryContext.runId)) throw new AgentProfileAdmissionError({ detail: 'watchdog_receipt' })
    if (watchdog === 'started' || watchdog === 'unstarted') {
      try {
        // A started task keeps its exact role, while B's live source is checked
        // again. An unstarted selection must still match the editable head.
        await (watchdog === 'started' ? assertProfileTarget : assertProfileSelection)(query,
          { ownerId: input.ownerId, workspaceId: input.workspaceId }, input.selection!)
      } catch (error) { throw new AgentProfileAdmissionError({ detail: 'watchdog_target', cause: error }) }
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
      const previous = source.agentDefinition.modelDispatch?.routing
      // A new execute attempt after a persisted failure may choose a higher
      // model while retaining a current inherited role. The locked Factory
      // chain, not a copied JSON flag, establishes this fresh admission.
      let routingRepair = false
      if (!same && input.selection && input.factoryContext && !input.factoryContext.runId && previous &&
          source.agentDefinition.modelDispatch?.mode === 'preference' &&
          source.agentDefinition.agentProfile.definition.model.mode === 'inherit' &&
          !source.stopRequestedAt && ['succeeded', 'failed', 'stopped'].includes(source.status) && input.model &&
          MODEL_ROUTING_TIERS.indexOf(modelTier(input.model)) > MODEL_ROUTING_TIERS.indexOf(previous.tier) &&
          isDeepStrictEqual({ ...source.agentDefinition.agentProfile, targetEntry: undefined }, { ...input.selection, targetEntry: undefined })) {
        const admitted = await query.query(`SELECT 1 FROM factory_tasks t
          JOIN factory_attempts pending ON pending.id=t."attemptId" AND pending."taskId"=t.id
          JOIN factory_attempts failed ON failed."taskId"=t.id AND failed.position=pending.position-1
          JOIN factory_attempts origin ON origin."taskId"=t.id AND origin."runId"=$5 AND origin.stage='execute'
          WHERE t."userId"=$1 AND t."issueId"=$2 AND t."sourceEventId"=$3 AND pending.id=$4
            AND t.stage='execute' AND t.status='pending' AND pending.stage='execute' AND pending.status='pending' AND pending."runId" IS NULL
            AND COALESCE(pending.output->>'requestEpoch',$3::text)=$3::text
            AND COALESCE(failed.output->>'requestEpoch',$3::text)=$3::text AND failed.status='failed'
            AND ((failed.stage IN ('review','verify') AND failed.output->'completion'->'trustedFailureProvenance'='true'::jsonb)
              OR (failed.stage='execute' AND failed."runId"=$5 AND failed.output->>'reasonCode'='run_failed'))
            AND origin.position<pending.position
            AND NOT EXISTS (SELECT 1 FROM factory_attempts newer WHERE newer."taskId"=t.id AND newer.stage='execute'
              AND newer.position>origin.position AND newer.position<pending.position)
          FOR SHARE OF t,pending,failed,origin`, [input.ownerId, input.issueId, input.factoryContext.sourceEventId, input.factoryContext.attemptId, input.sourceRunId])
        routingRepair = Boolean(admitted.rowCount)
      }
      if (!same && !unclaimedStartup && !routingRepair && (!input.selection || !isBuiltinAgentProfileSelection(input.selection) || !isBuiltinAgentProfileSelection(source.agentDefinition.agentProfile))) throw new AgentProfileAdmissionError({ detail: 'continuation_mismatch' })
      // An unclaimed failed startup may retry the same role on a newly
      // authorized target. This is fresh admission, not a native continuation.
      // A legacy/default thread can make a fresh authorized model selection.
      // A changed model or source never inherits the old native-session grant.
      // Routing repairs still pass assertProfileSelection below and again at
      // claim: editing/archiving the profile can revoke the new execution.
      if (same && source.startedAt && source.sessionId) return input.sourceRunId
    }
  }
  if (!input.selection) return undefined
  try { await assertProfileSelection(query, { ownerId: input.ownerId, workspaceId: input.workspaceId }, input.selection) }
  catch (error) { throw new AgentProfileAdmissionError({ detail: 'current_profile', cause: error }) }
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
  if (!workspaceId || !run.issueId) throw new AgentProfileAdmissionError({ detail: 'scope_unavailable' })
  if ((definition.agentProfile.profileId === BUILTIN_AGENT_PROFILE_ID || definition.agentProfile.source === 'default') && (!isBuiltinAgentProfileSelection(definition.agentProfile) || definition.agentProfile.scope.ownerId !== run.userId || definition.agentProfile.scope.workspaceId !== workspaceId)) throw new AgentProfileAdmissionError({ detail: 'snapshot_invalid' })
  if (run.questionContinuation && run.kind === 'implement') {
    const { rows: [task] } = await query.query(`SELECT t.* FROM factory_tasks t
      JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id AND a."runId"=$1
      JOIN factory_questions q ON q."taskId"=t.id AND q."continuationRunId"=a."runId" AND q."userId"=t."userId" AND q."issueId"=t."issueId"
      WHERE t."userId"=$2 AND t."issueId"=$3 AND t.stage='execute' AND t.status='running' AND a.status='running'
        AND q.status='resuming' AND (q."expiresAt" IS NULL OR q."expiresAt">clock_timestamp()) FOR SHARE OF t,a,q`, [run.id,run.userId,run.issueId])
    const edge = task ? await (await import('./questions/execution-continuation')).questionExecutionContinuation(query,task,task.attemptId) : null
    if (!edge || run.stopRequestedAt || run.status !== 'queued') throw new AgentProfileAdmissionError({ detail: 'question_receipt' })
    const source = await admitProfileSelection(query, { ownerId: run.userId, workspaceId, issueId: run.issueId,
      harness: definition.harness, model: definition.model, apiKeyId: definition.apiKey?.keyId,
      subscriptionBindingId: definition.subscription?.bindingId, selection: definition.agentProfile, sourceRunId: edge.questionOriginRunId })
    if (source !== edge.questionOriginRunId) throw new AgentProfileAdmissionError({ detail: 'question_origin' })
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
    if (!run.retryOf) throw new AgentProfileAdmissionError({ detail: 'watchdog_receipt' })
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
