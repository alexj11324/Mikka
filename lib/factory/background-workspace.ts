import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { inDatabaseTransaction } from '@/lib/db/request-scope'
import { actAs } from '@/lib/acting-user'
import { actingContext } from '@/lib/activity-actor'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { borrowTaskWorkspaceMembership, withTaskWorkspace } from '@/lib/task-workspace'
import { FactoryError } from './contract'
import type { createFactoryStore } from './store'
import type { createFactoryQuestions } from './questions/store'

type Query = Pick<PoolClient, 'query'>
export type FactoryWorkspaceTarget =
  | { kind: 'task' | 'issue' | 'question' | 'run'; id: string; botId?: string | null }
  | { kind: 'bot'; id: string }
export type FactoryWorkspaceBoundary = <T>(userId: string, taskId: string, work: () => Promise<T>, existing?: PoolClient) => Promise<T>

function uuid(value: unknown): string {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new FactoryError('factoryInvalid')
  return parsed.data.toLowerCase()
}
export function factoryBackgroundReference(raw: unknown, field: 'issueId' | 'taskId' | 'questionId'): string {
  if (!raw || typeof raw !== 'object') throw new FactoryError('factoryInvalid')
  const record = raw as Record<string, unknown>
  if (field === 'issueId') return uuid(record.issueId)
  const nested = field === 'questionId' ? record.reference : record.binding
  return uuid(nested && typeof nested === 'object' ? (nested as Record<string, unknown>)[field] : undefined)
}
function bindingTaskId(raw: unknown): string {
  if (!raw || typeof raw !== 'object') throw new FactoryError('factoryInvalid')
  return uuid((raw as Record<string, unknown>).taskId)
}
const denied = () => new FactoryError('factoryNotFound')

/** This read chooses lock order only. The original store still checks its task,
 * issue, source, Bot and revision after it owns APP rows. No old scope, user home,
 * model input or absent workspace can assign a tenant. */
async function persistedWorkspace(query: Query, userId: string, target: FactoryWorkspaceTarget): Promise<string> {
  const id = uuid(target.id)
  let workspaceId: string | null | undefined
  if (target.kind === 'bot') {
    const { rows } = await query.query<{ workspaceId: string | null }>(
      'SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 AND "archivedAt" IS NULL', [id, userId])
    workspaceId = rows[0]?.workspaceId
  } else if (target.kind === 'run') {
    const { rows } = await query.query<{ workspaceId: string | null }>(
      'SELECT "workspaceId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [id, userId])
    workspaceId = rows[0]?.workspaceId
  } else if (target.kind === 'issue') {
    const { rows } = await query.query<{ workspaceId: string | null }>(
      `SELECT i."workspaceId" FROM issues i WHERE i.id=$1 AND i."ownershipState"='bound'
        AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM bots b WHERE b.id=$3 AND b."ownerId"=$2
          AND b."workspaceId"=i."workspaceId" AND b."archivedAt" IS NULL))`,
      [id, userId, target.botId ?? null])
    workspaceId = rows[0]?.workspaceId
  } else {
    const question = target.kind === 'question'
    const { rows } = await query.query<{ workspaceId: string | null }>(
      `SELECT t."workspaceId" FROM factory_tasks t
        JOIN issues i ON i.id=t."issueId" AND i."ownershipState"='bound' AND i."workspaceId"=t."workspaceId"
        ${question ? 'JOIN factory_questions q ON q."taskId"=t.id AND q."userId"=t."userId" AND q."issueId"=t."issueId"' : ''}
        WHERE ${question ? 'q' : 't'}.id=$1 AND t."userId"=$2
          AND ($3::boolean OR t."botId" IS NOT DISTINCT FROM $4::uuid)
          AND (t."botId" IS NULL OR EXISTS (SELECT 1 FROM bots b WHERE b.id=t."botId" AND b."ownerId"=$2
            AND b."workspaceId"=t."workspaceId" AND b."archivedAt" IS NULL))`,
      [id, userId, target.botId === undefined, target.botId ?? null])
    workspaceId = rows[0]?.workspaceId
  }
  if (!workspaceId || !z.uuid().safeParse(workspaceId).success) throw denied()
  return workspaceId
}

async function inWorkspace<T>(userId: string, workspaceId: string, work: () => Promise<T>, existing?: PoolClient): Promise<T> {
  const actor = actingContext.getStore()
  if (actor && (actor.userId !== userId || (actor.tokenWorkspaceId && actor.tokenWorkspaceId !== workspaceId))) throw denied()
  const reader = { id: userId, [tokenWorkspace]: workspaceId,
    ...(actor?.enterprisePrincipal ? { [enterprisePrincipal]: actor.enterprisePrincipal } : {}) }
  const run = () => actAs(reader, work, actor?.actor)
  try {
    const borrowed = borrowTaskWorkspaceMembership(userId, workspaceId)
    if (borrowed) {
      try { await borrowed.check(); return await run() }
      finally { await borrowed.close() }
    }
    // A transaction owner must acquire WS first. Never repair an inverted
    // existing APP transaction by waiting for a new WS checkout here.
    if (existing || inDatabaseTransaction()) throw denied()
    return await withTaskWorkspace(reader, workspaceId, run)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'workspaceAccessDenied') throw new FactoryError('factoryNotFound', { cause: error })
    throw error
  }
}

/** Host boundary: released APP identity read -> WS/member lease -> original
 * APP owner. Existing transactions may only borrow their exact active lease. */
export async function withFactoryBackgroundWorkspace<T>(
  pool: Pick<Pool, 'query'>, userId: string, target: FactoryWorkspaceTarget,
  work: () => Promise<T>, existing?: PoolClient,
): Promise<T> {
  const workspaceId = await persistedWorkspace(existing ?? pool, userId, target)
  return inWorkspace(userId, workspaceId, work, existing)
}

export const factoryTaskWorkspaceBoundary = (pool: Pick<Pool, 'query'>, botId: string | null): FactoryWorkspaceBoundary =>
  (userId, taskId, work, existing) => withFactoryBackgroundWorkspace(pool, userId, { kind: 'task', id: taskId, botId }, work, existing)

type Store = ReturnType<typeof createFactoryStore>
/** Only methods that own a transaction are wrapped. Their original existing-tx
 * implementation and all source/revision fences are unchanged. Input failures
 * remain rejected Promises, matching the original async store contract. */
export function bindFactoryStoreWorkspace(pool: Pick<Pool, 'query'>, store: Store, botId: string | null): Store {
  const task = factoryTaskWorkspaceBoundary(pool, botId)
  return {
    ...store,
    route: async (...args: Parameters<Store['route']>) => withFactoryBackgroundWorkspace(pool, args[0],
      { kind: 'issue', id: factoryBackgroundReference(args[1], 'issueId'), botId }, () => store.route(...args), args[2]),
    read: (...args: Parameters<Store['read']>) => task(args[0], args[1], () => store.read(...args)),
    apply: async (...args: Parameters<Store['apply']>) => task(args[0], bindingTaskId(args[1]), () => store.apply(...args), args[4]),
    recheckCandidate: async (...args: Parameters<Store['recheckCandidate']>) => task(args[0], bindingTaskId(args[1]), () => store.recheckCandidate(...args)),
    retryCheckStart: async (...args: Parameters<Store['retryCheckStart']>) => task(args[0], bindingTaskId(args[1]), () => store.retryCheckStart(...args)),
    retryCompletion: async (...args: Parameters<Store['retryCompletion']>) => task(args[0], bindingTaskId(args[1]), () => store.retryCompletion(...args)),
    retryDeliverableSnapshot: async (...args: Parameters<Store['retryDeliverableSnapshot']>) => task(args[0], bindingTaskId(args[1]), () => store.retryDeliverableSnapshot(...args)),
    listForIssue: (...args: Parameters<Store['listForIssue']>) => withFactoryBackgroundWorkspace(pool, args[0],
      { kind: 'issue', id: args[1], ...(args[2]?.anyBot ? {} : { botId }) }, () => store.listForIssue(...args)),
    listPublicForIssue: (...args: Parameters<Store['listPublicForIssue']>) => withFactoryBackgroundWorkspace(pool, args[0],
      { kind: 'issue', id: args[1], botId }, () => store.listPublicForIssue(...args)),
  }
}

type Questions = ReturnType<typeof createFactoryQuestions>
export function bindFactoryQuestionsWorkspace(pool: Pick<Pool, 'query'>, questions: Questions, botId: string | null): Questions {
  const question = <T>(userId: string, id: string, work: () => Promise<T>) =>
    withFactoryBackgroundWorkspace(pool, userId, { kind: 'question', id, botId }, work)
  const run = <T>(userId: string, id: string, work: () => Promise<T>, existing?: PoolClient) =>
    withFactoryBackgroundWorkspace(pool, userId, { kind: 'run', id }, work, existing)
  return {
    ...questions,
    read: (...args: Parameters<Questions['read']>) => question(args[0], args[1], () => questions.read(...args)),
    list: (...args: Parameters<Questions['list']>) => withFactoryBackgroundWorkspace(pool, args[0],
      { kind: 'task', id: args[1], ...(args[2] === 'user' ? {} : { botId }) }, () => questions.list(...args)),
    record: (...args: Parameters<Questions['record']>) => run(args[0], args[1], () => questions.record(...args), args[2]),
    settle: (...args: Parameters<Questions['settle']>) => run(args[0], args[1], () => questions.settle(...args), args[2]),
    escalate: async (...args: Parameters<Questions['escalate']>) => question(args[0], factoryBackgroundReference(args[1], 'questionId'), () => questions.escalate(...args)),
    answer: async (...args: Parameters<Questions['answer']>) => question(args[0].userId, factoryBackgroundReference(args[1], 'questionId'), () => questions.answer(...args)),
    recover: async (...args: Parameters<Questions['recover']>) => question(args[0].userId, factoryBackgroundReference(args[1], 'questionId'), () => questions.recover(...args)),
    claimContinuation: (...args: Parameters<Questions['claimContinuation']>) => run(args[0], args[2], () => questions.claimContinuation(...args),
      typeof args[4] === 'function' ? undefined : args[4]),
    async pending(userId, runId, readScope = 'bot') {
      if (runId) return run(userId, runId, () => questions.pending(userId, runId, readScope))
      const acting = actingContext.getStore()
      if (acting?.userId === userId && acting.tokenWorkspaceId)
        return inWorkspace(userId, acting.tokenWorkspaceId, () => questions.pending(userId, undefined, readScope))
      if (botId && readScope === 'bot') return withFactoryBackgroundWorkspace(pool, userId,
        { kind: 'bot', id: botId }, () => questions.pending(userId, undefined, readScope))
      // Legacy botless background work can span tenants. Each original pending
      // query runs under one persisted tenant; never pick the owner's home.
      const { rows } = await pool.query<{ workspaceId: string }>(`SELECT DISTINCT t."workspaceId" FROM factory_tasks t
        JOIN factory_questions q ON q."taskId"=t.id AND q."userId"=t."userId"
        JOIN issues i ON i.id=t."issueId" AND i."ownershipState"='bound' AND i."workspaceId"=t."workspaceId"
        WHERE t."userId"=$1 AND t."workspaceId" IS NOT NULL AND ($2::boolean OR t."botId" IS NOT DISTINCT FROM $3::uuid)
          AND q.status IN ('open','waiting_user','resuming','blocked') ORDER BY t."workspaceId"`, [userId, readScope === 'user', botId])
      const result: Awaited<ReturnType<Questions['pending']>> = []
      for (const row of rows) {
        try { result.push(...await inWorkspace(userId, row.workspaceId, () => questions.pending(userId, undefined, readScope))) }
        catch (error) { if (!(error instanceof FactoryError) || error.code !== 'factoryNotFound') throw error }
      }
      return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id.localeCompare(a.id)).slice(0, 50)
    },
  }
}
