import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { after } from 'next/server'
import { and, eq, gt, inArray, isNull, notInArray, or } from 'drizzle-orm'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { db } from '@/lib/db'
import { agentRuns, runTokens } from '@/lib/db/schema'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runBlockedEvent, runQuestionEvent, runReportEvent, type CoordinatorEventInput } from '@/lib/coordinator-events'
import { maskForRun } from '@/lib/secrets/runtime'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { issueForUser } from '@/lib/issue-access'
import { agentScope } from '@/lib/agent-kit/service'
import { AgentKitError } from '@/lib/agent-kit/store'
import { LEASED_RUN_STATUSES } from '@/lib/run-retry'

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

async function currentRunToken(bearerToken: string) {
  const [row] = await db
    .select({ runId: runTokens.runId, userId: runTokens.userId, expiresAt: runTokens.expiresAt, issueId: agentRuns.issueId, agentId: agentRuns.agentId, botId: agentRuns.botId })
    .from(runTokens)
    .innerJoin(agentRuns, eq(agentRuns.id, runTokens.runId))
    .where(and(
      eq(runTokens.tokenHash, hashToken(bearerToken)), isNull(runTokens.revokedAt), gt(runTokens.expiresAt, new Date()),
      eq(agentRuns.userId, runTokens.userId), inArray(agentRuns.status, [...LIVE_STATUSES]),
      isNull(agentRuns.stopRequestedAt),
      or(isNull(agentRuns.deviceId), notInArray(agentRuns.status, [...LEASED_RUN_STATUSES]), gt(agentRuns.leaseExpiresAt, new Date())),
    ))
    .limit(1)
  return row
}

/** A live token is scoped to the current task and Bot permissions. Removing
 * workspace membership shuts a worker out on its next call, including tools
 * whose ordinary result is only a report or artifact. */
export async function verifyRunToken(_request: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken?.startsWith(RUN_TOKEN_PREFIX)) return undefined
  const row = await currentRunToken(bearerToken)
  if (!row || (row.issueId && !await issueForUser(row.userId, row.issueId))) return undefined
  if (row.botId) {
    try { await agentScope(row.userId, row.botId) }
    catch (error) { if (error instanceof AgentKitError) return undefined; throw error }
  }
  // Permission reads may wait on the workspace DB. STOP, token revocation and
  // lease expiry must still take effect before authority is returned.
  if ((row.issueId || row.botId) && !await currentRunToken(bearerToken)) return undefined
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

// 4e2 item 4: report/ask/blocked text is agent output persisted as coordinator events; masked with the run's secret set.
export async function report(run: ReturnType<typeof workerRun>, text: string) {
  await deliver(runReportEvent(run, await maskForRun(run.id, text)))
  return 'Reported.'
}

export async function ask(run: ReturnType<typeof workerRun>, question: { question: string; options?: string[]; context?: string }) {
  await deliver(runQuestionEvent(run, await maskForRun(run.id, question)))
  return 'Asked. The answer will come as a follow-up instruction.'
}

export async function blocked(run: ReturnType<typeof workerRun>, reason: string) {
  await deliver(runBlockedEvent(run, await maskForRun(run.id, reason)))
  return 'Noted. The Coordinator will tell the person.'
}
