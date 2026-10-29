import 'server-only'
import type { PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { RunCompleteRequest } from '@mikka/protocol/run'
import { FactoryError } from './factory/contract'
import { lockSkillScope } from './self-improvement/registry'

type RunIdentity = { id: string; userId: string; botId: string | null }
type RunScope = { issueId: string | null; deviceRepoId: string | null }

/** Cancellation and answers lock Factory task before issue/run. Include old
 * attempts and continuations so a late completion never reverses that order. */
export async function lockFactoryCompletionTasks(client: PoolClient, userId: string, runId: string) {
  const { rows } = await client.query(`SELECT t.id FROM factory_tasks t WHERE t."userId"=$2 AND (
    EXISTS (SELECT 1 FROM factory_attempts a WHERE a."taskId"=t.id AND a."runId"=$1)
    OR EXISTS (SELECT 1 FROM factory_questions q WHERE q."taskId"=t.id AND q."userId"=$2
      AND (q."originRunId"=$1 OR q."continuationRunId"=$1))) ORDER BY t.id FOR UPDATE OF t`, [runId, userId])
  return rows.length > 0
}

/** Called after the issue lock and before the run lock, like skill selection
 * and claim. The monitor's activation scope is pinned by its locked task. */
export async function lockCompletionSkillScopes(client: PoolClient, userId: string, runId: string, scope: RunScope, factoryBound: boolean) {
  if (!scope.issueId) return
  const scopes = new Map<string, { issueId: string; repoId: string }>()
  const add = (issueId: string, repoId: string) => scopes.set(JSON.stringify([userId, issueId, repoId]), { issueId, repoId })
  if (scope.deviceRepoId) add(scope.issueId, scope.deviceRepoId)
  if (factoryBound) {
    const { rows } = await client.query(`SELECT c."issueId",c."repoId" FROM factory_tasks t
      JOIN factory_attempts a ON a.id=t."attemptId"
      JOIN improvement_skill_candidates c ON c."factoryTaskId"=t.id AND c."candidateId"=t."candidateId" AND c."userId"=t."userId"
      WHERE a."runId"=$1 AND t."userId"=$2 AND t.stage='monitor' AND c."issueId"=$3`, [runId, userId, scope.issueId])
    for (const row of rows) add(row.issueId, row.repoId)
  }
  for (const [, value] of [...scopes].sort(([a], [b]) => a.localeCompare(b))) await lockSkillScope(client, userId, value.issueId, value.repoId)
}

async function optionalFactoryEffect(client: PoolClient, name: 'completion_monitor_probe' | 'completion_question_settle' | 'completion_question_record', effect: () => Promise<unknown>) {
  await client.query(`SAVEPOINT ${name}`)
  try { await effect() }
  catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
    if (!(error instanceof FactoryError)) throw error
  } finally { await client.query(`RELEASE SAVEPOINT ${name}`) }
}

/** This must run only for the first completion, before the terminal run write,
 * using the same transaction as its immutable report and publication receipt. */
export async function prepareRunCompletionEffects(client: PoolClient, run: RunIdentity, completion: RunCompleteRequest, factoryBound: boolean) {
  let report = completion.report
  if (report?.skillMount || report?.execution || report?.runtime) {
    const { recordCompletionSkillMount } = await import('./self-improvement/skill-mounts')
    const { skillEvaluations } = await import('./self-improvement/server')
    const { issueForUser } = await import('./issue-access')
    report = await recordCompletionSkillMount(client, run.userId, run.id, completion.stopReason, report,
      async (userId, issueId, tx) => Boolean(await issueForUser(userId, issueId, false, drizzle(tx))),
      skillEvaluations.authorizeEvaluation, skillEvaluations.validateExecution)
  }
  if (factoryBound && completion.stopReason === 'submitted') {
    const { factoryMonitor } = await import('./factory/server')
    // Existing adapters do bounded readback: a five-second local child or
    // provider HTTP timeouts. Keep their task/run binding held through IO.
    await optionalFactoryEffect(client, 'completion_monitor_probe', () => factoryMonitor.probeRun(run.userId, run.id, client, report))
  }
  return report
}

/** Question state and the terminal run commit together; a rollback must never
 * consume an answer while leaving its run live, or record a premature question. */
export async function settleRunCompletionEffects(client: PoolClient, run: RunIdentity, stopReason: RunCompleteRequest['stopReason'], factoryBound: boolean) {
  if (!factoryBound) return
  const { factoryQuestions } = await import('./factory/server')
  const questions = process.env.MIKKA_FACTORY_ROUTING_ENABLED === '1' && process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED === '1'
    ? (await import('./factory/runtime')).factoryRuntimeForBot(run.botId).questions
    : factoryQuestions
  await optionalFactoryEffect(client, 'completion_question_settle', () => questions.settle(run.userId, run.id, client))
  if (stopReason === 'asked_human' || stopReason === 'blocked') await optionalFactoryEffect(client, 'completion_question_record', () => questions.record(run.userId, run.id, client))
}
