import { withFactoryBackgroundWorkspace, type FactoryWorkspaceBoundary } from './background-workspace'
import { randomUUID } from 'node:crypto'
import { factoryChanged } from '../live/factory'
import { runControlChanged } from '../device-gateway-notify'
import type { Pool, PoolClient } from 'pg'
import { FactoryError } from './contract'
import { ActionFailureError } from '../action-error'
import { checkFactoryRepairBudget } from './check-recovery-evidence'
import { factoryEventId } from './event-id'
import { factoryBinding } from './dispatch'
import { persistFactoryHandoff } from './handoff'
import type { FactoryTask, createFactoryStore } from './store'

export const WATCHDOG_MAX_RECOVERIES = 3
const TERMINAL = ['succeeded', 'completed', 'failed', 'stopped', 'cancelled']
export type Progress = { task: FactoryTask; runId: string | null; runStatus: string | null; progressAt: Date; activeRun: boolean; uncertainEffect: boolean; providerPending?: boolean; watchdog?: { reasonCode?: string; requestEpoch?: string; stoppedAt?: string } }

/** Lease/heartbeat timestamps are intentionally absent. Tool results,
 * checkpoints, candidates and stage transitions are the persisted progress. */
export function factoryWatchdogDecision(value: Progress, now: Date) {
  // Explicit human control and input waits are owned by their existing paths.
  if (value.runStatus === 'paused' || value.runStatus === 'waiting_input') return 'wait' as const
  if (value.uncertainEffect) return 'external_effect' as const
  // The dedicated provider recovery pass below owns this durable intent. A
  // racing observation must not spend transport/watchdog repair attempts.
  if (value.providerPending && value.task.status === 'running') return 'wait' as const
  if (value.task.status === 'blocked' && value.watchdog?.reasonCode === 'task_stalled' && value.watchdog.requestEpoch === value.task.sourceEventId) {
    if (!value.activeRun && (!value.runStatus || TERMINAL.includes(value.runStatus))) return 'recover_stall' as const
    if (value.watchdog.stoppedAt && now.getTime() - Date.parse(value.watchdog.stoppedAt) >= 5 * 60_000) return 'stop_timeout' as const
    return 'wait' as const
  }
  if (value.runStatus && TERMINAL.includes(value.runStatus) && value.task.status === 'running') return 'reconcile' as const
  if (value.task.status === 'pending' && !value.activeRun && ['execute', 'review', 'verify'].includes(value.task.stage)) return 'dispatch' as const
  const threshold = value.task.stage === 'execute' ? 45 * 60_000 : 20 * 60_000
  if (['pending', 'running'].includes(value.task.status) && now.getTime() - value.progressAt.getTime() >= threshold) return 'stalled' as const
  return 'wait' as const
}

type Runtime = { store: ReturnType<typeof createFactoryStore>; reconcile: { run(userId: string, runId: string): Promise<unknown> } }
type Dispatch = (tx: PoolClient, store: ReturnType<typeof createFactoryStore>, task: FactoryTask, run: Record<string, unknown>) => Promise<(() => Promise<void>) | undefined>
export type WatchdogDependencies = { runtime(botId: string | null): Runtime; dispatch: Dispatch; wake(userId: string, botId: string | null): Promise<unknown>
  /** Host/test transaction boundary; never accepted from a watchdog request. */
  withWorkspace?: FactoryWorkspaceBoundary
  /** Recover outside task locks, then launch only after reconciliation adopts it. */
  recoverProvider?(userId: string, runId: string): Promise<(() => Promise<void>) | undefined>
  recoverQuestion?(userId: string, runId: string, now: Date): Promise<{ handled: boolean; launched: boolean }>
}

/** Bounded sweep called by the existing independent run-recovery cron. The
 * durable attempt receipt serializes overlapping sweeps and limits retries.
 * It only reuses host reconciliation/dispatch; semantic replanning remains
 * with the Coordinator's Decisions API. */
export async function sweepFactoryWatchdog(pool: Pool, dependencies?: WatchdogDependencies, now = new Date(), deadline = Date.now() + 20_000, completed?: { userId: string; runId: string }) {
  if (!dependencies) {
    const runtime = await import('./runtime')
    if (!runtime.factoryLifecycleEnabled()) return { scanned: 0, recovered: 0, blocked: 0, deferred: 0, failed: 0 }
    const { automaticFactoryDispatch } = await import('./automatic-dispatch')
    const { wakeCoordinator } = await import('../coordinator/wake')
    dependencies = { runtime: runtime.factoryRuntimeForBot, dispatch: automaticFactoryDispatch(pool), wake: (userId) => wakeCoordinator(userId) }
  }
  const host = dependencies
  const counts = { scanned: 0, recovered: 0, blocked: 0, deferred: 0, failed: 0 }
  const { rows: candidates } = await pool.query(`SELECT t.id,t."userId",t."botId",a."runId",
    (t.status='running' AND t.stage='execute' AND live.status='queued' AND live."stopRequestedAt" IS NULL
      AND live."questionContinuation"->>'requireSessionResume'='true'
      AND EXISTS(SELECT 1 FROM factory_questions q WHERE q."taskId"=t.id AND q."continuationRunId"=live.id
        AND q."userId"=t."userId" AND q.status='resuming' AND (q."expiresAt" IS NULL OR q."expiresAt">clock_timestamp()))) AS "questionPending",
    (t.status='running' AND live."stopRequestedAt" IS NULL AND (
      (live.status='failed' AND live."stopReason"='provider_failure' AND live.report->'modelFallback'->>'state'='pending')
      OR (live.status='queued' AND previous.status='failed' AND previous."stopReason"='provider_failure' AND previous."stopRequestedAt" IS NULL
        AND previous.report->'modelFallback'->>'state'='switched' AND previous.report->'modelFallback'->>'retryRunId'=live.id::text
        AND previous.report->'modelFallback'->>'nextDefinitionDigest'=live."agentDefinition"->>'definitionDigest'))) AS "providerPending",
    CASE WHEN live.status='queued' THEN previous.id ELSE live.id END AS "providerRunId"
    FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId"
    LEFT JOIN agent_runs live ON live.id=a."runId"
    LEFT JOIN LATERAL (SELECT source.id FROM factory_events e JOIN agent_runs source ON source.id::text=e.request->>'priorRunId'
      WHERE e."taskId"=t.id AND e.result->>'runId'=live.id::text AND t.stage IN ('review','verify','monitor')
        AND source.report->'modelFallback'->>'retryRunId'=live.id::text LIMIT 1) provider_check ON live."retryOf" IS NULL
    LEFT JOIN agent_runs previous ON previous.id=COALESCE(live."retryOf",provider_check.id) AND previous."userId"=t."userId" AND previous."issueId"=t."issueId"
    WHERE (t.status IN ('pending','running') OR (t.status='blocked' AND a.output->'watchdog'->>'reasonCode'='task_stalled'))
      AND EXISTS (SELECT 1 FROM "user" u WHERE u.id=t."userId")
      AND t.stage IN ('spec','execute','review','verify','monitor')
      AND (live.status IS NULL OR live.status NOT IN ('paused','waiting_input'))
      AND (($2::text IS NULL AND t."updatedAt" < $1::timestamptz - interval '1 minute'
        AND NOT EXISTS(SELECT 1 FROM factory_events w WHERE w."taskId"=t.id AND w.request->>'kind'='task_watchdog'
          AND w.request->>'attemptId'=t."attemptId"::text AND (w.result->>'nextAt')::timestamptz>$1))
        OR (t."userId"=$2 AND a."runId"=$3::uuid))
      ORDER BY t."updatedAt",t.id LIMIT 40`, [now, completed?.userId ?? null, completed?.runId ?? null])
  for (const candidate of candidates) {
    if (Date.now() >= deadline) { counts.deferred++; continue }
    counts.scanned++
    const runtime = host.runtime(candidate.botId)
    if (candidate.questionPending) {
      // The answer has already committed. Retry only its exact queued child;
      // generic stall recovery must not stop it or create another attempt.
      try {
        const result = host.recoverQuestion
          ? await host.recoverQuestion(candidate.userId, candidate.runId, now)
          : await (await import('./questions/wake')).wakeQueuedQuestionContinuation(pool, candidate.userId, candidate.runId, now)
        if (result.handled) {
          if (result.launched) counts.recovered++
          else counts.deferred++
          continue
        }
        // Lost machine/custody/authority is not managed wake work. Leave the
        // existing stall/stop path responsible instead of deferring forever.
      } catch { counts.failed++; continue }
    }
    if (candidate.providerPending) {
      // A crash between completion and handoff must heal even when no worker
      // replays completion. The recovery path re-locks and reauthorizes the
      // current task itself; this pass holds no DB connection or task lock.
      try {
        let launch: (() => Promise<void>) | undefined
        if (host.recoverProvider) launch = await host.recoverProvider(candidate.userId, candidate.providerRunId)
        else {
          const { recoverProviderFailure, launchProviderContinuation } = await import('../run-provider-fallback')
          const continuation = await recoverProviderFailure(pool, candidate.userId, candidate.providerRunId)
          launch = () => launchProviderContinuation(candidate.userId, continuation)
        }
        await runtime.reconcile.run(candidate.userId, candidate.providerRunId)
        await launch?.()
        counts.recovered++
      } catch { counts.failed++ }
      continue
    }
    const { beginFactoryTransaction, commitFactoryTransaction, rollbackFactoryTransaction, forgetFactoryTransaction, factoryAuthorizationCheckpoint } = await import('./transaction')
    let wake = false, recovered = false
    let start: (() => Promise<void>) | undefined
    let reconcileRun: string | undefined
    const afterCommit = async () => {
      await start?.()
      if (reconcileRun) { await runtime.reconcile.run(candidate.userId, reconcileRun); counts.recovered++ }
      if (wake) await host.wake(candidate.userId, candidate.botId)
    }
    const transact = async () => {
    const tx = await pool.connect()
    try {
      await beginFactoryTransaction(tx)
      const task = await runtime.store.lockTask(tx, candidate.userId, candidate.id)
      if (!['pending', 'running', 'blocked'].includes(task.status)) { await commitFactoryTransaction(tx); return }
      const { rows: [state] } = await tx.query(`SELECT a."runId",r.status AS "runStatus",a.output->'watchdog' AS watchdog,
        (r."stopRequestedAt" IS NULL AND (
          (r.status='failed' AND r."stopReason"='provider_failure' AND r.report->'modelFallback'->>'state'='pending')
          OR (r.status='queued' AND previous.status='failed' AND previous."stopReason"='provider_failure' AND previous."stopRequestedAt" IS NULL
            AND previous.report->'modelFallback'->>'state'='switched' AND previous.report->'modelFallback'->>'retryRunId'=r.id::text
            AND previous.report->'modelFallback'->>'nextDefinitionDigest'=r."agentDefinition"->>'definitionDigest'))) AS "providerPending",
        r."questionContinuation" IS NOT NULL AS "originalSessionOnly",
        GREATEST(t."updatedAt",a."createdAt",a."finishedAt",c."createdAt",cp."updatedAt",
          (SELECT max(ch."createdAt") FROM run_chunks ch WHERE ch."runId"=r.id AND ch.chunk->>'type'='tool_output')) AS "progressAt",
        EXISTS(SELECT 1 FROM factory_attempts prior JOIN agent_runs active ON active.id=prior."runId"
          WHERE prior."taskId"=t.id AND active.status IN ('queued','preparing','running','paused','waiting_input','finishing')) AS "activeRun",
        (EXISTS(SELECT 1 FROM factory_publications p WHERE p."taskId"=t.id AND p.status IN ('reserved','uncertain'))
          OR EXISTS(SELECT 1 FROM operation_ledger o WHERE o."ownerId"=t."userId" AND o.status IN ('executing','uncertain')
            AND EXISTS(SELECT 1 FROM factory_attempts op WHERE op."taskId"=t.id
              AND (op."runId"=o."runId" OR op."runId"::text=o.binding->>'executionRunId')))
          OR EXISTS(SELECT 1 FROM run_publications p JOIN factory_attempts op ON op."runId"=p."runId"
            WHERE op."taskId"=t.id AND p."userId"=t."userId" AND p.status='processing')) AS "uncertainEffect"
        FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId"
        LEFT JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
        LEFT JOIN LATERAL (SELECT source.id FROM factory_events e JOIN agent_runs source ON source.id::text=e.request->>'priorRunId'
          WHERE e."taskId"=t.id AND e.result->>'runId'=r.id::text AND t.stage IN ('review','verify','monitor')
            AND source.report->'modelFallback'->>'retryRunId'=r.id::text LIMIT 1) provider_check ON r."retryOf" IS NULL
        LEFT JOIN agent_runs previous ON previous.id=COALESCE(r."retryOf",provider_check.id) AND previous."userId"=t."userId" AND previous."issueId"=t."issueId"
        LEFT JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
        LEFT JOIN run_checkpoints cp ON cp."runId"=r.id AND cp."userId"=t."userId" WHERE t.id=$1`, [task.id])
      if (!state) { await commitFactoryTransaction(tx); return }
      const action = factoryWatchdogDecision({ task, ...state }, now)
      const eventId = factoryEventId('task-watchdog', `${task.attemptId}:${task.sourceEventId}`)
      const { rows: [previous] } = await tx.query('SELECT result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, eventId])
      if (action === 'wait') {
        // Progressing long tasks must not permanently occupy the first page of
        // the bounded cron scan. Heartbeats still do not advance progressAt.
        await tx.query(`INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)
          ON CONFLICT("taskId","eventId") DO UPDATE SET result=EXCLUDED.result`, [task.id, eventId,
          JSON.stringify({ kind: 'task_watchdog', requestEpoch: task.sourceEventId, attemptId: task.attemptId }),
          JSON.stringify({ ...previous?.result, action: previous?.result?.action ?? 'wait', observedAt: now.toISOString(), progressAt: state.progressAt,
            nextAt: new Date(now.getTime() + (task.status === 'blocked' ? 60_000 : 5 * 60_000)).toISOString() })])
        await commitFactoryTransaction(tx); return
      }
      if (previous?.result?.nextAt && Date.parse(previous.result.nextAt) > now.getTime()
        && !(completed && action === 'recover_stall' && previous.result.action === 'stalled')) { counts.deferred++; await commitFactoryTransaction(tx); return }
      const tries = action === 'stalled' ? 0 : (previous?.result?.tries ?? 0) + 1
      const { rows: [budget] } = await tx.query(`SELECT COALESCE(sum(COALESCE((result->>'recoveryTries')::int,0)),0)::int AS count
        FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='task_watchdog' AND request->>'requestEpoch'=$2`, [task.id, task.sourceEventId])
      const recoveryTries = (previous?.result?.recoveryTries ?? 0) + (action === 'recover_stall' ? 1 : 0)
      const handoff = await persistFactoryHandoff(tx, task)
      const exhausted = tries > WATCHDOG_MAX_RECOVERIES || (action === 'recover_stall' && budget.count >= WATCHDOG_MAX_RECOVERIES)
      const recoverable = action === 'stalled' && !state.originalSessionOnly && ['execute','review','verify'].includes(task.stage)
      const blocked = action === 'stalled' || action === 'external_effect' || action === 'stop_timeout' || exhausted
      const reason = action === 'external_effect' ? 'An external action has an uncertain receipt. Reconcile it before any replay.'
        : action === 'stalled' && state.originalSessionOnly ? 'The original-session question continuation stalled. Restore its original machine before resuming; its answer must not be replayed elsewhere.'
        : action === 'stalled' ? 'No persisted task progress within the stage window. Check the executor and workspace before resuming.'
          : action === 'stop_timeout' ? 'The old executor has not acknowledged its stop. Restore or disconnect it before another worker can safely resume.'
          : 'Automatic recovery attempts are exhausted. Restore the executor or credential and explicitly resume this task.'
      if (blocked) {
        const output = { watchdog: { reasonCode: action === 'external_effect' ? 'external_effect_uncertain' : recoverable ? 'task_stalled' : action === 'stop_timeout' ? 'stop_unacknowledged' : 'recovery_exhausted', requestEpoch: task.sourceEventId, handoffDigest: handoff.digest, stoppedAt: now.toISOString() } }
        if (task.status === 'blocked') {
          // A blocker observation changes no acceptance state. Its revision
          // still advances so a concurrent operator cannot resume stale facts.
          await tx.query('UPDATE factory_tasks SET reason=$2,revision=revision+1,"updatedAt"=now() WHERE id=$1', [task.id, reason])
          await tx.query('UPDATE factory_attempts SET reason=$2,output=output || $3::jsonb WHERE id=$1', [task.attemptId, reason, JSON.stringify(output)])
        } else await runtime.store.apply(task.userId, factoryBinding(task), factoryEventId('watchdog-block', eventId), {
          action: 'finish', status: 'blocked', reason, evidence: [], output,
        }, tx)
        const { rows: stoppedRuns } = await tx.query<{ id: string }>(`UPDATE agent_runs SET "stopRequestedAt"=COALESCE("stopRequestedAt",now()),"updatedAt"=now()
          WHERE id IN(SELECT "runId" FROM factory_attempts WHERE "taskId"=$1) AND "userId"=$2
            AND status IN ('queued','preparing','running','paused','waiting_input','finishing') RETURNING id`, [task.id, task.userId])
        runControlChanged(tx, { runIds: stoppedRuns.map(run => run.id) })
        await tx.query(`UPDATE run_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "userId"=$2
          AND "runId" IN(SELECT "runId" FROM factory_attempts WHERE "taskId"=$1)`, [task.id, task.userId])
        if (!recoverable) await tx.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload)
          VALUES($1,$2,$3,$4,'run_report',$5,$6) ON CONFLICT("dedupeKey") DO NOTHING`, [randomUUID(), task.userId, task.botId, task.issueId,
          `task-watchdog:${task.id}:${task.sourceEventId}`, JSON.stringify({ source: 'task_watchdog', taskId: task.id, requestEpoch: task.sourceEventId, reason, text: reason,
            handoffEventId: handoff.eventId, handoffDigest: handoff.digest, instruction: 'One actionable blocker; use the existing Decision API to decide whether the owner needs notification. Do not replay uncertain external effects.' })])
        wake = !recoverable
        counts.blocked++
      } else if (action === 'reconcile') reconcileRun = state.runId
      else {
        // A failed provider/credential admission rolls back its partial work,
        // but keeps the attempt counter so cron cannot retry indefinitely.
        const restoreProfileAuthority = factoryAuthorizationCheckpoint(tx)
        await tx.query('SAVEPOINT watchdog_dispatch')
        try {
          let current = task
          if (action === 'recover_stall') {
            await checkFactoryRepairBudget(tx, task)
            current = (await runtime.store.apply(task.userId, factoryBinding(task), factoryEventId('watchdog-retry', eventId), {
              action: 'retry', reason: 'Resume the same target after the stalled executor acknowledged its stop.',
            }, tx)).task
            await tx.query('UPDATE factory_attempts SET output=output || $2::jsonb WHERE id=$1', [current.attemptId,
              JSON.stringify({ watchdogRecovery: { previousRunId: state.runId, requestEpoch: task.sourceEventId, handoffDigest: handoff.digest } })])
          }
          start = await host.dispatch(tx, runtime.store, current, { id: state.runId })
          recovered = true
        }
        catch (error) {
          await tx.query('ROLLBACK TO SAVEPOINT watchdog_dispatch')
          restoreProfileAuthority()
          if (!(error instanceof FactoryError) && !(error instanceof ActionFailureError)) throw error
          counts.deferred++
        }
        await tx.query('RELEASE SAVEPOINT watchdog_dispatch')
      }
      await tx.query(`INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)
        ON CONFLICT("taskId","eventId") DO UPDATE SET result=EXCLUDED.result`, [task.id, eventId,
        JSON.stringify({ kind: 'task_watchdog', requestEpoch: task.sourceEventId, attemptId: task.attemptId }),
        JSON.stringify({ action, tries, recoveryTries, blocked, handoffDigest: handoff.digest, observedAt: now.toISOString(), progressAt: state.progressAt,
          recoveryLatencyMs: now.getTime() - new Date(state.progressAt).getTime(), nextAt: new Date(now.getTime() + Math.min(15, 2 ** tries) * 60_000).toISOString() })])
      await factoryChanged(tx, task)
      await commitFactoryTransaction(tx)
      if (recovered) counts.recovered++
    } catch (error) {
      start = undefined; wake = false; reconcileRun = undefined
      await rollbackFactoryTransaction(tx)
      if (!(error instanceof FactoryError) || !['factoryNotFound', 'factoryStopped', 'factoryStale'].includes(error.code)) counts.failed++
    } finally { forgetFactoryTransaction(tx); tx.release() }
    }
    try {
      const workspace: FactoryWorkspaceBoundary = host.withWorkspace ?? ((userId, taskId, work) =>
        withFactoryBackgroundWorkspace(pool, userId, { kind: 'task', id: taskId, botId: candidate.botId }, work))
      await workspace(candidate.userId, candidate.id, transact)
    } catch (error) {
      start = undefined; wake = false; reconcileRun = undefined
      if (!(error instanceof FactoryError) || !['factoryNotFound', 'factoryStopped', 'factoryStale'].includes(error.code)) counts.failed++
    }
    try { await afterCommit() } catch { counts.failed++ }
  }
  return counts
}
