import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { after } from 'next/server'
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { db } from '@/lib/db'
import { agentRuns, runTokens, issues, issueMembers } from '@/lib/db/schema'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runBlockedEvent, runQuestionEvent, runReportEvent, type CoordinatorEventInput } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { issueForUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { teamIssues } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'

// The worker side of the MCP server: the agent inside a run reports progress,
// asks the person something or says it is blocked. Each call becomes an event
// in the owner's Coordinator inbox. The agent signs in with a run token, not
// OAuth: the claim hands one to the daemon, which mounts the server into the
// run.

/** Prefix of run tokens; it tells the route which tools to serve. */
export const RUN_TOKEN_PREFIX = 'mkw_'
/** Longest a run token lives, even while its run is still going. */
const RUN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
/** A run in one of these states may still use its token. */
const LIVE_STATUSES = ['queued', 'preparing', 'running', 'waiting_input', 'finishing'] as const

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Creates a token for one run. Only its hash is stored; the token itself goes to the daemon once. */
export async function issueRunToken(run: { id: string; userId: string }): Promise<{ token: string; expiresAt: Date }> {
  const token = `${RUN_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  const expiresAt = new Date(Date.now() + RUN_TOKEN_TTL_MS)
  await db.insert(runTokens).values({ id: crypto.randomUUID(), runId: run.id, userId: run.userId, tokenHash: hashToken(token), expiresAt })
  return { token, expiresAt }
}

/** Revokes every token of a run; call it when the run ends. */
export async function revokeRunTokens(runId: string): Promise<void> {
  await db.update(runTokens).set({ revokedAt: new Date() }).where(and(eq(runTokens.runId, runId), isNull(runTokens.revokedAt)))
}

/**
 * Resolve current authority, not the permission that existed at queue time.
 * Reuse the issue policy so workspace suspension and task visibility changes
 * apply equally to human and worker entrypoints.
 */
async function currentRun(bearerToken?: string, executor: Pick<typeof db, 'select'> = db, workspaceExecutor: Pick<typeof workspaceDb, 'select'> = workspaceDb, lock = false) {
  if (!bearerToken?.startsWith(RUN_TOKEN_PREFIX)) return undefined
  const query = executor
    .select({ runId: runTokens.runId, userId: runTokens.userId, expiresAt: runTokens.expiresAt, issueId: agentRuns.issueId })
    .from(runTokens)
    .innerJoin(agentRuns, eq(agentRuns.id, runTokens.runId))
    .where(and(
      eq(runTokens.tokenHash, hashToken(bearerToken)), isNull(runTokens.revokedAt), gt(runTokens.expiresAt, new Date()),
      eq(agentRuns.userId, runTokens.userId), inArray(agentRuns.status, [...LIVE_STATUSES]),
      isNull(agentRuns.stopRequestedAt),
    ))
    .limit(1)
  const [row] = await (lock ? query.for('share') : query)
  if (!row?.issueId || !await issueForUser(row.userId, row.issueId, false, executor, workspaceExecutor) || row.expiresAt.getTime() <= Date.now()) return undefined
  return row
}

/** Authenticate every HTTP request against the current run and issue policy. */
export async function verifyRunToken(_request: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  const row = await currentRun(bearerToken)
  if (!row || !bearerToken) return undefined
  return {
    token: bearerToken, clientId: `run:${row.runId}`, scopes: [],
    expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
    extra: { userId: row.userId, runId: row.runId, issueId: row.issueId },
  }
}

/** The run a worker request comes from. */
export function workerRun(authInfo: AuthInfo | undefined): { id: string; userId: string; issueId: string | null; token: string } {
  const extra = authInfo?.extra
  if (typeof extra?.runId !== 'string' || typeof extra.userId !== 'string' || typeof authInfo?.token !== 'string') throw new Error('MCP request is not a run')
  return { id: extra.runId, userId: extra.userId, issueId: typeof extra.issueId === 'string' ? extra.issueId : null, token: authInfo.token }
}

async function deliver(event: CoordinatorEventInput, token: string): Promise<void> {
  // Hold current authority through the event commit. Workspace data can live
  // in a separate database: keep its read locks until the app transaction ends.
  // Reuse the relation writers' lock in shared mode, then lock issue before run
  // (the same order as issue deletion/member removal). Never borrow another
  // pool connection inside these scopes: both pools are bounded.
  if (!event.issueId) throw new Error('MCP run authorization is no longer valid')
  await workspaceDb.transaction(async workspaceTx => {
    await workspaceTx.execute(sql`set local lock_timeout = '5s'`)
    await workspaceTx.execute(sql`set local statement_timeout = '10s'`)
    await workspaceTx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('mikka-team-relations', 0))`)
    const [link] = await workspaceTx.select().from(teamIssues).where(eq(teamIssues.issueId, event.issueId!)).for('share').limit(1)
    if (link) await workspaceTx.select().from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, link.workspaceId), eq(workspaceMembers.userId, event.userId),
    )).for('share')
    await db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`)
      await tx.execute(sql`set local statement_timeout = '10s'`)
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, event.issueId!)).for('share')
      await tx.select().from(issueMembers).where(and(eq(issueMembers.issueId, event.issueId!), eq(issueMembers.memberId, event.userId))).for('share')
      // Match deletion's run -> token order instead of relying on a join plan.
      await tx.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, event.runId!)).for('share')
      const run = await currentRun(token, tx, workspaceTx, true)
      if (!run || run.runId !== event.runId || run.userId !== event.userId || run.issueId !== event.issueId) {
        throw new Error('MCP run authorization is no longer valid')
      }
      await recordCoordinatorEvent(tx, event)
    })
  })
  after(() => wakeCoordinator(event.userId))
}

export async function report(run: ReturnType<typeof workerRun>, text: string) {
  await deliver(runReportEvent(run, text), run.token)
  return 'Reported.'
}

export async function ask(run: ReturnType<typeof workerRun>, question: { question: string; options?: string[]; context?: string }) {
  await deliver(runQuestionEvent(run, question), run.token)
  return 'Asked. The answer will come as a follow-up instruction.'
}

export async function blocked(run: ReturnType<typeof workerRun>, reason: string) {
  await deliver(runBlockedEvent(run, reason), run.token)
  return 'Noted. The Coordinator will tell the person.'
}
