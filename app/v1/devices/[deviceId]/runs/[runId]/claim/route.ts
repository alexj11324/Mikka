import { NextResponse } from 'next/server'
import { and,eq,isNull } from 'drizzle-orm'
import { RUN_LEASE_MS,REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { db } from '@/lib/db'
import { agentRuns, agents, deviceRepos } from '@/lib/db/schema'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'
import { withBasePath } from '@/lib/base-path'
import { mcpResourceURL } from '@/lib/mcp/resource'
import { issueRunToken } from '@/lib/mcp/worker'
import { latestCheckpoint } from '@/lib/run-leases'
import { retryNote } from '@/lib/run-retry'
import { pool } from '@/lib/db'
import { isFactoryCheckRun } from '@/lib/factory/checks'
import { claimFactoryCheckRun, guardExecutionRun, factoryQuestions } from '@/lib/factory/server'
import { blockQuestionRetry } from '@/lib/factory/questions/retry'
import { SKILL_ARTIFACT_HEADER } from '@mikka/protocol/skill'
import { claimBenchmarkAssignment, skillAssignments } from '@/lib/self-improvement/server'
import { FactoryError } from '@/lib/factory/contract'
import { ImprovementError } from '@/lib/self-improvement/contract'
import { claimCloudRun, claimLocalRun, prepareLocalClaimBinding } from '@/lib/computer/claim'
import { subscriptionRuntime } from '@/lib/subscription-runtime'
import { personalMailboxEnabled } from '@/lib/personal-mailbox-config'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/devices/:deviceId/runs/:runId/claim`: hands the daemon everything
 * it needs to run. 409 means the run is not queued for this device — the
 * daemon's `RunNotPinnedHereError`, and it stops asking.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ deviceId: string; runId: string }> },
) {
  const caller = await authenticateDevice(request)
  if (!caller)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId, runId } = await params
  const device = await ownedDevice(deviceId, caller.userId)
  if (!device)
    return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  if (!device.enabled)
    return NextResponse.json(
      { error: 'Scheduling is off for this device.' },
      { status: 409 },
    )
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.deviceId, deviceId),
        eq(agentRuns.status, 'queued'),
        isNull(agentRuns.stopRequestedAt),
      ),
    )
    .limit(1)
  if (!run)
    return NextResponse.json(
      { error: 'Run is not queued for this device.' },
      { status: 409 },
    )
  if (run.retryOf && run.issueId && await blockQuestionRetry(pool, caller.userId, run.issueId, runId))
    return NextResponse.json(
      { error: 'Generic retry cannot resume a question continuation.' },
      { status: 409 },
    )
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, run.agentId))
    .limit(1)
  const [repo] = run.deviceRepoId
    ? await db
        .select()
        .from(deviceRepos)
        .where(eq(deviceRepos.id, run.deviceRepoId))
        .limit(1)
    : []
  if (!agent || !repo || !run.issueId) {
    await db
      .update(agentRuns)
      .set({
        status: 'failed',
        stopReason: 'error',
        error: 'Run is missing its agent, repository or issue.',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId))
    return NextResponse.json(
      { error: 'Run is missing its agent, repository or issue.' },
      { status: 409 },
    )
  }
  if (repo.remoteUrl && request.headers.get(REPO_ORIGIN_HEADER) !== '1')
    return NextResponse.json({ error: 'Device update required for repository verification.' }, { status: 409 })
  const harness = run.agentDefinition?.harness ?? agent.harness
  const pinned = run.agentDefinition?.subscription
  let subscription: Awaited<ReturnType<ReturnType<typeof subscriptionRuntime>['repository']['nativeBinding']>>
  try { subscription = process.env.MIKKA_BYOS_ENABLED === '1'
    ? pinned ? await subscriptionRuntime().repository.binding(caller.userId,pinned.bindingId) : run.agentDefinition ? null : await subscriptionRuntime().repository.nativeBinding(caller.userId, agent.id, harness) : null
  } catch { return NextResponse.json({ error:'Subscription unavailable.' },{ status:409 }) }
  if (pinned && (!subscription || subscription.id !== pinned.bindingId || subscription.modelId !== pinned.modelId || subscription.route !== pinned.route || subscription.consumerId !== agent.id || subscription.ownerId !== caller.userId)) return NextResponse.json({ error:'Pinned subscription unavailable.' },{ status:409 })
  if (subscription && (run.userId !== caller.userId || agent.userId !== caller.userId || repo.userId !== caller.userId)) return NextResponse.json({ error: 'Run owner mismatch.' }, { status: 409 })
  if (subscription && !device.harnesses.some(info => info.harness === harness && info.subscriptionBroker)) return NextResponse.json({ error: 'Subscription requires a broker-enabled hosted runner.' }, { status: 409 })
  const leaseExpiresAt = new Date(Date.now() + RUN_LEASE_MS).toISOString()
  const supportsSkillArtifacts = request.headers.get(SKILL_ARTIFACT_HEADER) === '1'
  try {
    await skillAssignments.preflight(caller.userId, runId, supportsSkillArtifacts)
  } catch (error) {
    if (!(error instanceof ImprovementError)) throw error
    return NextResponse.json({ error: error.code }, { status: error.code === 'notFound' ? 404 : 409 })
  }
  let computer:Awaited<ReturnType<typeof claimCloudRun>>=null
  const nativeClaim=async(tx:import('pg').PoolClient)=>{
    if(await prepareLocalClaimBinding(tx,runId,subscription?.id)!=='ready')throw new FactoryError('factoryRunMismatch')
  }
  let checkAssignment
  let claimed
  if(device.kind==='cloud'){
    if(run.questionContinuation || (run.kind==='acceptance'&&await isFactoryCheckRun(pool,caller.userId,runId)))return NextResponse.json({error:'Factory check/continuation requires its existing local execution capability.'},{status:409})
    if(process.env.MIKKA_CLOUD_COMPUTER_TASKS!=='1'||caller.scopeDeviceId!==deviceId||!caller.scopeWorkspaceId||!subscription||subscription.workspaceId!==caller.scopeWorkspaceId||!device.harnesses.some(info=>info.harness===harness&&info.computerBroker))return NextResponse.json({error:'Cloud computer worker unavailable.'},{status:409})
    try {
    computer=await claimCloudRun(pool,{userId:caller.userId,workspaceId:caller.scopeWorkspaceId},runId,deviceId,new Date(leaseExpiresAt),subscription.id,tx=>guardExecutionRun(tx,caller.userId,runId))
    } catch(error) {
      if(!(error instanceof FactoryError))throw error
      return NextResponse.json({error:'Execution binding is unavailable or stale.'},{status:409})
    }
    if(!computer)return NextResponse.json({error:'Cloud computer run unavailable.'},{status:409})
    claimed=[{id:runId}]
  } else if (run.questionContinuation) {
    try {
      checkAssignment = await factoryQuestions.claimContinuation(
        caller.userId,
        deviceId,
        runId,
        leaseExpiresAt,
        nativeClaim,
      )
      claimed = [{ id: runId }]
    } catch {
      await db
        .update(agentRuns)
        .set({
          status: 'failed',
          stopReason: 'blocked',
          error:
            'Original question/session continuation is unavailable or no longer authorized.',
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'queued')))
      await factoryQuestions.settle(caller.userId, runId).catch(() => null)
      return NextResponse.json(
        { error: 'Question continuation is unavailable or stale.' },
        { status: 409 },
      )
    }
  } else if (
    run.kind === 'acceptance' &&
    (await isFactoryCheckRun(pool, caller.userId, runId))
  ) {
    try {
      checkAssignment = await claimFactoryCheckRun(
        caller.userId,
        deviceId,
        runId,
        leaseExpiresAt,
        nativeClaim,
      )
      claimed = [{ id: runId }]
    } catch {
      await db
        .update(agentRuns)
        .set({
          status: 'failed',
          stopReason: 'blocked',
          error: 'Independent check binding is unavailable or stale.',
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'queued')))
      return NextResponse.json(
        { error: 'Independent check binding is unavailable or stale.' },
        { status: 409 },
      )
    }
  } else {
    try {
      const local=await claimLocalRun(pool,runId,deviceId,new Date(leaseExpiresAt),subscription?.id,tx=>guardExecutionRun(tx,caller.userId,runId))
      if(local==='cloud-required')return NextResponse.json({error:'Cloud computer worker required.'},{status:409})
      claimed=local==='claimed'?[{id:runId}]:[]
    } catch (error) {
      if (!(error instanceof FactoryError)) throw error
      return NextResponse.json({ error: 'Execution binding is unavailable or stale.' }, { status: 409 })
    }
  }
  if (!claimed.length)
    return NextResponse.json(
      { error: 'Run is already claimed.' },
      { status: 409 },
    )
  let skillAssignment
  let benchmarkAssignment
  try {
    skillAssignment = await skillAssignments.recordClaim(caller.userId, deviceId, runId, leaseExpiresAt, supportsSkillArtifacts)
    benchmarkAssignment = await claimBenchmarkAssignment(caller.userId,deviceId,runId,leaseExpiresAt)
  } catch (error) {
    // No assignment bytes are returned when provenance cannot be recorded.
    await db.update(agentRuns).set({ status: 'failed', stopReason: 'blocked', error: 'Skill assignment provenance unavailable.', finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, caller.userId), eq(agentRuns.status, 'preparing'), eq(agentRuns.leaseExpiresAt, new Date(leaseExpiresAt))))
    if (!(error instanceof ImprovementError)) throw error
    return NextResponse.json({ error: error.code }, { status: 409 })
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
    ? await db
        .select({ sessionId: agentRuns.sessionId })
        .from(agentRuns)
        .where(eq(agentRuns.id, run.retryOf))
        .limit(1)
    : []
  const resumeFrom = run.retryOf ? await latestCheckpoint(run.retryOf) : null
  const retry = run.retryOf
    ? {
        continuesRunId: run.retryOf,
        followUp: retryNote(run.attempt),
        ...(lost?.sessionId ? { resumeSessionId: lost.sessionId } : {}),
        ...(resumeFrom ? { resumeFrom } : {}),
      }
    : {}
  return NextResponse.json({
    runId,
    issueId: run.issueId,
    deviceId,
    repoId: repo.id,
    ...(repo.remoteUrl ? { expectedRepoRemote: repo.remoteUrl } : {}),
    baseBranch: run.baseBranch,
    harness,
    prompt: run.prompt,
    kind: run.kind,
    leaseExpiresAt,
    ...(repo.verifyCommand ? { verifyCommand: repo.verifyCommand } : {}),
    ...(mcp ? { mcp } : {}),
    ...(subscription ? { model: subscription.modelId, subscriptionBinding: { bindingId: subscription.id, ownerId: subscription.ownerId, workspaceId: subscription.workspaceId, consumerId: subscription.consumerId, route: subscription.route } } : {}),
    ...(computer ? { computer } : {}),
    ...retry,
    ...checkAssignment,
    ...skillAssignment,
    ...benchmarkAssignment,
  })
}
