import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { RUN_LEASE_MS } from '@mikka/protocol/device'
import { db } from '@/lib/db'
import { agentRuns, agents, deviceRepos } from '@/lib/db/schema'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'
import { withBasePath } from '@/lib/base-path'
import { mcpResourceURL } from '@/lib/mcp/resource'
import { issueRunToken } from '@/lib/mcp/worker'
import { latestCheckpoint } from '@/lib/run-leases'
import { retryNote } from '@/lib/run-retry'
import { tenantQuotas } from '@/lib/quota/runtime'
import type { Reservation } from '@/lib/quota/store'
import { QuotaError, quotaResponse } from '@/lib/quota/errors'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/devices/:deviceId/runs/:runId/claim`: hands the daemon everything
 * it needs to run. 409 means the run is not queued for this device — the
 * daemon's `RunNotPinnedHereError`, and it stops asking.
 */
export async function POST(request: Request, { params }: { params: Promise<{ deviceId: string; runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId, runId } = await params
  const device = await ownedDevice(deviceId, caller.userId)
  if (!device) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  if (!device.enabled) return NextResponse.json({ error: 'Scheduling is off for this device.' }, { status: 409 })
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, caller.userId), eq(agentRuns.deviceId, deviceId), eq(agentRuns.status, 'queued')))
    .limit(1)
  if (!run) return NextResponse.json({ error: 'Run is not queued for this device.' }, { status: 409 })
  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId)).limit(1)
  const [repo] = run.deviceRepoId
    ? await db.select().from(deviceRepos).where(eq(deviceRepos.id, run.deviceRepoId)).limit(1)
    : []
  if (!agent || !repo || !run.issueId) {
    await db.update(agentRuns)
      .set({ status: 'failed', stopReason: 'error', error: 'Run is missing its agent, repository or issue.', finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRuns.id, runId))
    return NextResponse.json({ error: 'Run is missing its agent, repository or issue.' }, { status: 409 })
  }
  let quota: Reservation
  try {
    quota = await tenantQuotas.reserveBound({ ownerId: run.userId, key: `daemon:${run.id}`, resource: 'daemon.run', binding: { runId, issueId: run.issueId, agentId: run.agentId, repoId: repo.id }, leaseMs: RUN_LEASE_MS }, async (client, active) => {
      const { rows } = await client.query(`UPDATE agent_runs SET status='preparing',"startedAt"=clock_timestamp(),
        "leaseExpiresAt"=$4,"quotaReservationId"=$5,"updatedAt"=clock_timestamp()
        WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3 AND status='queued' AND "quotaReservationId" IS NULL AND "startedAt" IS NULL AND "leaseExpiresAt" IS NULL RETURNING id`,
      [runId, run.userId, deviceId, active.expires_at, active.id])
      if (!rows.length) throw new QuotaError('quotaRunClaimLost', 409)
    }, async client => {
      // Only a never-claimed queued run can recover a legacy refunded orphan.
      // Claim delivery always persists preparing/startedAt/quota binding first.
      const proof = await client.query(`SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3
        AND status='queued' AND "quotaReservationId" IS NULL AND "startedAt" IS NULL AND "leaseExpiresAt" IS NULL FOR UPDATE`, [runId, run.userId, deviceId])
      return proof.rowCount === 1
    })
  } catch (error) {
    if (error instanceof QuotaError) return quotaResponse(error)
    return NextResponse.json({ error: 'quotaUnavailable' }, { status: 503 })
  }
  // The run and quota share one persisted deadline, including any wait between
  // reservation and activation. A lost response cannot reissue this payload.
  const leaseExpiresAt = quota.expires_at.toISOString()
  // The worker tools of the MCP server for the agent in this run. A failure
  // here should not keep the run from starting.
  const mcp = await issueRunToken(run)
      .then(({ token }) => ({ url: mcpResourceURL ?? new URL(withBasePath('/api/mcp'), request.url).toString(), token }))
      .catch((error: unknown) => { console.error('Could not issue a run token', error instanceof Error ? error.message : error); return undefined })
  // A retry after a lost lease works on in the lost attempt's worktree and,
  // when the harness can, its session; the daemon falls back to `prompt`.
  // Another machine has no such worktree and starts from the latest
  // checkpoint instead.
  const [lost] = run.retryOf
    ? await db.select({ sessionId: agentRuns.sessionId }).from(agentRuns).where(eq(agentRuns.id, run.retryOf)).limit(1)
    : []
  const resumeFrom = run.retryOf ? await latestCheckpoint(run.retryOf) : null
  const retry = run.retryOf
    ? {
      continuesRunId: run.retryOf, followUp: retryNote(run.attempt),
      ...(lost?.sessionId ? { resumeSessionId: lost.sessionId } : {}),
      ...(resumeFrom ? { resumeFrom } : {}),
    }
    : {}
  // Do not hand a newly constructed payload to a worker after its deadline.
  if (Date.now() >= quota.expires_at.getTime()) return quotaResponse(new QuotaError('quotaLeaseLost', 409))
  return NextResponse.json({
    runId, issueId: run.issueId, deviceId, repoId: repo.id,
    baseBranch: repo.baseBranch, harness: agent.harness, prompt: run.prompt,
    kind: run.kind, leaseExpiresAt,
    ...(repo.verifyCommand ? { verifyCommand: repo.verifyCommand } : {}),
    ...(mcp ? { mcp } : {}),
    ...retry,
  })
}
