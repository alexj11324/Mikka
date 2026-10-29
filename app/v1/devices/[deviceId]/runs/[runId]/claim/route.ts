import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { RUN_LEASE_MS } from '@mikka/protocol/device'
import { db, pool } from '@/lib/db'
import { agentRuns, agents, deviceRepos } from '@/lib/db/schema'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'
import { withBasePath } from '@/lib/base-path'
import { mcpResourceURL } from '@/lib/mcp/resource'
import { issueRunToken } from '@/lib/mcp/worker'
import { latestCheckpoint } from '@/lib/run-leases'
import { retryNote } from '@/lib/run-retry'
import { claimCloudRun, claimLocalRun } from '@/lib/computer/claim'
import { nativeRunBinding } from '@/lib/computer/native-run-binding'
import { subscriptionRuntime } from '@/lib/subscription-runtime'
import { personalMailboxEnabled } from '@/lib/personal-mailbox-config'

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
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.deviceId, deviceId), eq(agentRuns.status, 'queued')))
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
  const harness = run.agentDefinition?.harness ?? agent.harness
  const pinned = run.agentDefinition?.subscription
  let subscription: Awaited<ReturnType<ReturnType<typeof subscriptionRuntime>['repository']['nativeBinding']>>
  try { subscription = process.env.MIKKA_BYOS_ENABLED === '1'
    ? run.agentDefinition && !pinned ? null : device.kind === 'cloud'
      ? await nativeRunBinding(pool, caller.userId, agent.id, harness, caller.scopeWorkspaceId, pinned?.bindingId)
      : pinned ? await subscriptionRuntime().repository.binding(caller.userId,pinned.bindingId) : await subscriptionRuntime().repository.nativeBinding(caller.userId, agent.id, harness) : null
  } catch { return NextResponse.json({ error:'Subscription unavailable.' },{ status:409 }) }
  if (pinned && (!subscription || subscription.id !== pinned.bindingId || subscription.modelId !== pinned.modelId || subscription.route !== pinned.route || subscription.consumerId !== agent.id || subscription.ownerId !== caller.userId)) return NextResponse.json({ error:'Pinned subscription unavailable.' },{ status:409 })
  if (subscription && (run.userId !== caller.userId || agent.userId !== caller.userId || repo.userId !== caller.userId)) return NextResponse.json({ error: 'Run owner mismatch.' }, { status: 409 })
  if (subscription && !device.harnesses.some(info => info.harness === harness && info.subscriptionBroker)) return NextResponse.json({ error: 'Subscription requires a broker-enabled hosted runner.' }, { status: 409 })
  const leaseExpiresAt = new Date(Date.now() + RUN_LEASE_MS).toISOString()
  let computer: Awaited<ReturnType<typeof claimCloudRun>> = null
  if (device.kind === 'cloud') {
    if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1' || caller.scopeDeviceId !== deviceId || !caller.scopeWorkspaceId || !subscription || subscription.workspaceId !== caller.scopeWorkspaceId || !device.harnesses.some(info => info.harness === harness && info.computerBroker)) return NextResponse.json({ error: 'Cloud computer worker unavailable.' }, { status: 409 })
    computer = await claimCloudRun(pool, { userId: caller.userId, workspaceId: caller.scopeWorkspaceId }, runId, deviceId, new Date(leaseExpiresAt), subscription.id)
    if (!computer) return NextResponse.json({ error: 'Cloud computer run unavailable.' }, { status: 409 })
  } else {
    const claim = await claimLocalRun(pool, runId, deviceId, new Date(leaseExpiresAt), subscription?.id)
    if (claim !== 'claimed') return NextResponse.json({ error: claim === 'cloud-required' ? 'Cloud computer worker required.' : 'Run is no longer queued for this device.' }, { status: 409 })
  }
  // The worker tools of the MCP server for the agent in this run. A failure
  // here should not keep the run from starting.
  const mcp = await issueRunToken(run)
      .then(async ({ token }) => {
        const tools = personalMailboxEnabled() ? await (await import('@/lib/personal-mailbox-runtime')).personalWorkerMailboxAdvertised(caller.userId, run.id) : []
        return { url: mcpResourceURL ?? new URL(withBasePath('/api/mcp'), request.url).toString(), token, ...(tools.length ? { mailbox: true as const } : {}) }
      })
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
  return NextResponse.json({
    runId, issueId: run.issueId, deviceId, repoId: repo.id,
    baseBranch: repo.baseBranch, harness, prompt: run.prompt,
    kind: run.kind, leaseExpiresAt,
    ...(repo.verifyCommand ? { verifyCommand: repo.verifyCommand } : {}),
    ...(mcp ? { mcp } : {}),
    ...(subscription ? { model: subscription.modelId, subscriptionBinding: { bindingId: subscription.id, ownerId: subscription.ownerId, workspaceId: subscription.workspaceId, consumerId: subscription.consumerId, route: subscription.route } } : {}),
    ...(computer ? { computer } : {}),
    ...retry,
  })
}
