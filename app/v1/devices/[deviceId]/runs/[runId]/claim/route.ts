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
import { beginQuota, tenantQuotas } from '@/lib/quota/runtime'
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
  const leaseExpiresAt = new Date(Date.now() + RUN_LEASE_MS).toISOString()
  let quota: Awaited<ReturnType<typeof beginQuota>>
  try {
    quota = await beginQuota({ ownerId: run.userId, key: `daemon:${run.id}`, resource: 'daemon.run', binding: { runId, issueId: run.issueId, agentId: run.agentId, repoId: repo.id }, leaseMs: RUN_LEASE_MS })
  } catch (error) {
    if (error instanceof QuotaError) return quotaResponse(error)
    return NextResponse.json({ error: 'quotaUnavailable' }, { status: 503 })
  }
  const claimed = await db.update(agentRuns)
    .set({ status: 'preparing', startedAt: new Date(), leaseExpiresAt: new Date(leaseExpiresAt), quotaReservationId: quota.id, updatedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'queued')))
    .returning({ id: agentRuns.id })
  if (!claimed.length) {
    await tenantQuotas.finish(run.userId, quota.id, 'refunded')
    return NextResponse.json({ error: 'Run is no longer queued.' }, { status: 409 })
  }
  // The worker tools of the MCP server for the agent in this run. A failure
  // here should not keep the run from starting.
  const mcp = claimed.length
    ? await issueRunToken(run)
      .then(({ token }) => ({ url: mcpResourceURL ?? new URL(withBasePath('/api/mcp'), request.url).toString(), token }))
      .catch((error: unknown) => { console.error('Could not issue a run token', error instanceof Error ? error.message : error); return undefined })
    : undefined
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
  return NextResponse.json({
    runId, issueId: run.issueId, deviceId, repoId: repo.id,
    baseBranch: repo.baseBranch, harness: agent.harness, prompt: run.prompt,
    kind: run.kind, leaseExpiresAt,
    ...(repo.verifyCommand ? { verifyCommand: repo.verifyCommand } : {}),
    ...(mcp ? { mcp } : {}),
    ...retry,
  })
}
