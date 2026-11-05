import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { entryKey } from '@/lib/model-order-plan'
import { factoryEventId } from './event-id'
import { isBuiltinAgentProfileSelection, type AgentProfileSelection } from './agent-profile-definition'

export type ProfileFactoryContext = { attemptId: string; sourceEventId: string; runId?: string }
type Query = Pick<Pool | PoolClient, 'query'>

type Event = { eventId: string; request: { kind?: string; attemptId?: string; requestEpoch?: string; binding?: { taskId?: string }; change?: { action?: string } }; result: { action?: string; task?: { id?: string; attemptId?: string; sourceEventId?: string; stage?: string; status?: string } } }
function watchdogRetryMatches(observed: Event, retry: Event | undefined, taskId: string, attemptId: string) {
  const epoch = observed.request.requestEpoch, previous = observed.request.attemptId
  return observed.request.kind === 'task_watchdog' && typeof epoch === 'string' && typeof previous === 'string' &&
    observed.eventId === factoryEventId('task-watchdog', `${previous}:${epoch}`) &&
    ['stalled', 'recover_stall'].includes(observed.result.action ?? '') &&
    retry?.eventId === factoryEventId('watchdog-retry', observed.eventId) && retry.request.change?.action === 'retry' &&
    retry.request.binding?.taskId === taskId && retry.result.task?.id === taskId && retry.result.task.attemptId === attemptId &&
    retry.result.task.sourceEventId === epoch && retry.result.task.stage === 'execute' && retry.result.task.status === 'pending'
}

/** A stopped manual retry is not a watchdog recovery. The immutable retry event
 * also identifies a real watchdog child after its mutable output was removed. */
export async function watchdogProfileClaimContext(query: Query, run: { id: string; userId: string; issueId: string }) {
  const { rows: [attempt] } = await query.query(`SELECT t.id AS "taskId",a.id,t."sourceEventId",a.output ? 'watchdogRecovery' AS recovery
    FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id
    WHERE a."runId"=$1 AND t."userId"=$2 AND t."issueId"=$3`, [run.id, run.userId, run.issueId])
  if (!attempt) return undefined
  if (!attempt.recovery) {
    const { rows: events } = await query.query<Event>(`SELECT "eventId",request,result FROM factory_events WHERE "taskId"=$1
      AND (request->>'kind'='task_watchdog' OR (request->'change'->>'action'='retry' AND result->'task'->>'attemptId'=$2))`, [attempt.taskId, attempt.id])
    const byId = new Map(events.map(event => [event.eventId, event]))
    attempt.recovery = events.some(event => watchdogRetryMatches(event, byId.get(factoryEventId('watchdog-retry', event.eventId)), attempt.taskId, attempt.id))
  }
  return attempt.recovery ? { attemptId: attempt.id as string, sourceEventId: attempt.sourceEventId as string, runId: run.id } : undefined
}

/** The queue supplies its already-checked Factory context; claim supplies the
 * actual bound run. Neither context nor copied JSON can grant recovery alone. */
export async function watchdogProfileAdmission(query: Query, input: {
  ownerId: string; workspaceId: string; issueId: string; sourceRunId: string
  harness: string; model?: string; selection?: AgentProfileSelection
}, context: ProfileFactoryContext): Promise<'none' | 'invalid' | 'unstarted' | 'started'> {
  const { rows: [current] } = await query.query(`SELECT t.id,t.status,t.stage,t."sourceEventId",a.id AS "attemptId",
      a.status AS "attemptStatus",a."runId",a.position,a.output
    FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
    WHERE t."userId"=$1 AND t."issueId"=$2 AND t."sourceEventId"=$3 AND a.id=$4
    FOR SHARE OF t,a`, [input.ownerId, input.issueId, context.sourceEventId, context.attemptId])
  if (!current) return 'invalid'
  if (!Object.hasOwn(current.output ?? {}, 'watchdogRecovery')) return 'none'
  const recovery = current.output.watchdogRecovery
  if (!input.selection || current.stage !== 'execute' || !recovery ||
      recovery.previousRunId !== input.sourceRunId || recovery.requestEpoch !== current.sourceEventId ||
      typeof recovery.handoffDigest !== 'string' || !/^[a-f0-9]{64}$/.test(recovery.handoffDigest)) return 'invalid'
  if (context.runId ? current.status !== 'running' || current.attemptStatus !== 'running' || current.runId !== context.runId || current.output.requestEpoch !== current.sourceEventId
    : current.status !== 'pending' || current.attemptStatus !== 'pending' || current.runId !== null) return 'invalid'
  const { rows: [source] } = await query.query(`SELECT r.*,a.id AS "originAttemptId",a.position,a.output AS "originOutput"
    FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId"
    WHERE a."taskId"=$1 AND a.stage='execute' AND a.position<$2 AND r.id=$3 AND r."userId"=$4 AND r."issueId"=$5
      AND r."agentDefinition"->'executionIdentity'->>'workspaceId'=$6 FOR SHARE OF a,r`,
  [current.id, current.position, input.sourceRunId, input.ownerId, input.issueId, input.workspaceId])
  const original = source?.agentDefinition?.agentProfile
  const watchdog = source?.originOutput?.watchdog
  if (!source || !original || !source.stopRequestedAt || !source.finishedAt || !['succeeded','failed','stopped'].includes(source.status) ||
      source.questionContinuation || watchdog?.reasonCode !== 'task_stalled' || watchdog.requestEpoch !== current.sourceEventId ||
      original.scope?.ownerId !== input.ownerId || original.scope?.workspaceId !== input.workspaceId ||
      source.agentDefinition.harness !== input.harness || source.agentDefinition.model !== input.model ||
      original.targetEntry.harness !== input.harness || original.targetEntry.model !== input.model ||
      !isDeepStrictEqual({ ...original, targetEntry: undefined }, { ...input.selection, targetEntry: undefined })) return 'invalid'
  if ((original.source === 'default' || original.profileId === 'default') && !isBuiltinAgentProfileSelection(original)) return 'invalid'
  if ((original.definition.model.mode === 'fixed' || source.agentDefinition.modelDispatch?.mode === 'picked') &&
      entryKey(original.targetEntry) !== entryKey(input.selection.targetEntry)) return 'invalid'
  const observedId = factoryEventId('task-watchdog', `${source.originAttemptId}:${current.sourceEventId}`)
  const retryId = factoryEventId('watchdog-retry', observedId)
  const { rows: events } = await query.query<Event>('SELECT "eventId",request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=ANY($2::uuid[]) FOR SHARE', [current.id, [observedId, retryId]])
  const observed = events.find(event => event.eventId === observedId), retry = events.find(event => event.eventId === retryId)
  if (!observed || !watchdogRetryMatches(observed, retry, current.id, current.attemptId)) return 'invalid'
  // The recovery's handoff is the stopped-source observation, not the earlier
  // running observation recorded when the watchdog requested its stop.
  const handoff = await query.query(`SELECT 1 FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='task_handoff'
      AND request->>'requestEpoch'=$2 AND request->>'digest'=$3
      AND result->>'ownerId'=$4 AND result->>'issueId'=$5 AND result->>'taskId'=$1::text
      AND result->>'requestEpoch'=$2 AND result->>'attemptId'=$6 AND result->'lastRun'->>'runId'=$7
      AND result->'pending'->>'stage'='execute' FOR SHARE`,
  [current.id, current.sourceEventId, recovery.handoffDigest, input.ownerId, input.issueId, source.originAttemptId, source.id])
  if (!handoff.rowCount) return 'invalid'
  if (context.runId) {
    const { rows: [run] } = await query.query(`SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR SHARE`, [context.runId, input.ownerId, input.issueId])
    if (!run || run.retryOf !== source.id || run.continuesRunId !== source.id || run.stopRequestedAt ||
        run.agentDefinition?.profileOriginRunId || run.agentDefinition?.executionIdentity?.workspaceId !== input.workspaceId ||
        !isDeepStrictEqual(run.agentDefinition?.agentProfile, input.selection)) return 'invalid'
  }
  return source.startedAt ? 'started' : 'unstarted'
}
