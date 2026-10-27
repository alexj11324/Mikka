import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { after } from 'next/server'
import { and, eq, gt, inArray, isNull } from 'drizzle-orm'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { db } from '@/lib/db'
import { agentRuns, runTokens } from '@/lib/db/schema'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runBlockedEvent, runQuestionEvent, runReportEvent, type CoordinatorEventInput } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'

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
 * Checks a run token: unrevoked, unexpired, and its run still live. A run
 * that ended any way (completed, cancelled, failed at claim) shuts its token
 * out even before the revoke.
 */
export async function verifyRunToken(_request: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken?.startsWith(RUN_TOKEN_PREFIX)) return undefined
  const [row] = await db
    .select({ runId: runTokens.runId, userId: runTokens.userId, expiresAt: runTokens.expiresAt, issueId: agentRuns.issueId, agentId: agentRuns.agentId, botId: agentRuns.botId })
    .from(runTokens)
    .innerJoin(agentRuns, eq(agentRuns.id, runTokens.runId))
    .where(and(
      eq(runTokens.tokenHash, hashToken(bearerToken)), isNull(runTokens.revokedAt), gt(runTokens.expiresAt, new Date()),
      eq(agentRuns.userId, runTokens.userId), inArray(agentRuns.status, [...LIVE_STATUSES]),
    ))
    .limit(1)
  if (!row) return undefined
  return {
    token: bearerToken, clientId: `run:${row.runId}`, scopes: [],
    expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
    extra: { userId: row.userId, runId: row.runId, issueId: row.issueId, agentId: row.agentId, botId: row.botId },
  }
}

/** The run a worker request comes from. */
export function workerRun(authInfo: AuthInfo | undefined): { id: string; userId: string; botId: string | null; issueId: string | null } {
  const extra = authInfo?.extra
  if (typeof extra?.runId !== 'string' || typeof extra.userId !== 'string') throw new Error('MCP request is not a run')
  return { id: extra.runId, userId: extra.userId, botId: typeof extra.botId === 'string' ? extra.botId : null, issueId: typeof extra.issueId === 'string' ? extra.issueId : null }
}

async function deliver(event: CoordinatorEventInput): Promise<void> {
  await recordCoordinatorEvent(db, event)
  after(() => wakeCoordinator(event.userId))
}

export async function report(run: ReturnType<typeof workerRun>, text: string) {
  await deliver(runReportEvent(run, text))
  return 'Reported.'
}

export async function ask(run: ReturnType<typeof workerRun>, question: { question: string; options?: string[]; context?: string }) {
  await deliver(runQuestionEvent(run, question))
  return 'Asked. The answer will come as a follow-up instruction.'
}

export async function blocked(run: ReturnType<typeof workerRun>, reason: string) {
  await deliver(runBlockedEvent(run, reason))
  return 'Noted. The Coordinator will tell the person.'
}
