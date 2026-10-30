import { after, NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { readRepositorySettings } from '@/lib/device-repositories'
import { daemonTestMode, repositoryBindingMatches } from '@mikka/protocol/repository'
import { localExecutionHarnesses } from '@/lib/device-agents'
import { runTestFixture } from '@/lib/run-test-fixture'
import { RUN_LEASE_MS, REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { readCliRunPolicy } from '@/lib/agent-tool-approval/policy-store'
import { db, pool } from '@/lib/db'
import { agentRuns, agents, deviceRepos } from '@/lib/db/schema'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'
import { withBasePath } from '@/lib/base-path'
import { mcpResourceURL } from '@/lib/mcp/resource'
import { issueRunToken } from '@/lib/mcp/worker'
import { latestCheckpoint } from '@/lib/run-leases'
import { retryNote } from '@/lib/run-retry'
import { constrainedAssignmentPolicy } from '@/lib/run-assignment-policy'
import { localComputerAuthority } from '@/lib/computer/local-authority'
import { SKILL_ARTIFACT_HEADER } from '@mikka/protocol/skill'
import { claimBenchmarkAssignment, skillAssignments } from '@/lib/self-improvement/server'
import { ImprovementError } from '@/lib/self-improvement/contract'
import { claimCloudRun, claimLocalRun } from '@/lib/computer/claim'
import { nativeRunBinding } from '@/lib/computer/native-run-binding'
import { FactoryError } from '@/lib/factory/contract'
import { blockQuestionRetry } from '@/lib/factory/questions/retry'
import { afterRunEnded } from '@/lib/run-completion-effects'
import { subscriptionRuntime } from '@/lib/subscription-runtime'
import { PublicationError } from '@/lib/run-publication-result'
import { authorizedClaimResponse } from '@/lib/run-claim-response'
import { personalMailboxEnabled } from '@/lib/personal-mailbox-config'
import { remoteRepositoryRef, taskSecretEnv } from '@/lib/secrets/runtime'
import { byoE2BKeyEnabled } from '@/lib/secrets/flag'

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
  if (caller.scopeDeviceId && caller.scopeDeviceId !== deviceId) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const device = await ownedDevice(deviceId, caller.userId)
  if (!device) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  if (device.kind === 'local' && (device.protocolVersion ?? 0) < DAEMON_PROTOCOL_VERSION) return NextResponse.json({ error: 'Upgrade the Mikka daemon before starting this thread.', code: 'daemonUpgradeRequired', protocolVersion: DAEMON_PROTOCOL_VERSION }, { status: 409 })
  if (!device.enabled) return NextResponse.json({ error: 'Scheduling is off for this device.' }, { status: 409 })
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.deviceId, deviceId), eq(agentRuns.status, 'queued'), eq(agentRuns.userId, caller.userId), isNull(agentRuns.stopRequestedAt)))
    .limit(1)
  if (!run) return NextResponse.json({ error: 'Run is not queued for this device.' }, { status: 409 })
  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId)).limit(1)
  const [repo] = run.deviceRepoId
    ? await db.select().from(deviceRepos).where(eq(deviceRepos.id, run.deviceRepoId)).limit(1)
    : []
  if ((agent && agent.userId !== caller.userId) || (repo && (repo.userId !== caller.userId || repo.deviceId !== deviceId)))
    return NextResponse.json({ error: 'Run ownership unavailable.' }, { status: 409 })
  if (!agent || !repo || !run.issueId) {
    await db.update(agentRuns)
      .set({ status: 'failed', stopReason: 'error', error: 'Run is missing its agent, repository or issue.', finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRuns.id, runId))
    await afterRunEnded(caller.userId, runId)
    return NextResponse.json({ error: 'Run is missing its agent, repository or issue.' }, { status: 409 })
  }
  if (run.userId !== caller.userId || agent.userId !== caller.userId || repo.userId !== caller.userId || repo.deviceId !== deviceId) return NextResponse.json({ error: 'Run owner mismatch.' }, { status: 409 })
  if (device.kind === 'local' && !repositoryBindingMatches(repo.repoPath, repo.remoteUrl, { allowFile: daemonTestMode(process.env) })) return NextResponse.json({ error: 'Repository identity must be confirmed before scheduling a new thread.' }, { status: 409 })
  if (repo.remoteUrl && request.headers.get(REPO_ORIGIN_HEADER) !== '1') return NextResponse.json({ error: 'Device update required for repository verification.' }, { status: 409 })
  // Historical generic retries cannot turn an original-session answer into
  // a fresh execution, even when their Factory attempt is no longer present.
  if (run.retryOf && await blockQuestionRetry(pool, caller.userId, run.issueId, runId) && (await afterRunEnded(caller.userId, runId), true)) return NextResponse.json({ error: 'Generic retry cannot replay an original-session question answer; explicit recovery required.' }, { status: 409 })
  const supportsSkillArtifacts = request.headers.get(SKILL_ARTIFACT_HEADER) === '1'
  try { await skillAssignments.preflight(caller.userId, runId, supportsSkillArtifacts) } catch (error) {
    if (!(error instanceof ImprovementError)) throw error
    return NextResponse.json({ error: error.code }, { status: error.code === 'notFound' ? 404 : 409 })
  }
  const harness = run.agentDefinition?.harness ?? agent.harness
  if (device.kind === 'local' && (!repo.remoteUrl || !localExecutionHarnesses(device.harnesses).includes(harness))) return NextResponse.json({ error: 'Repository or execution harness unavailable.' }, { status: 409 })
  if ((harness === 'codex' || harness === 'claude_code') && !device.harnesses.some(info => info.harness === harness && info.installed && info.toolApproval === true)) return NextResponse.json({ error: 'Run approval capability unavailable.' }, { status: 409 })
  const pinned = run.agentDefinition?.subscription
  let subscription: Awaited<ReturnType<ReturnType<typeof subscriptionRuntime>['repository']['nativeBinding']>>
  try { subscription = process.env.MIKKA_BYOS_ENABLED === '1'
    ? run.agentDefinition && !pinned ? null : device.kind === 'cloud'
      ? await nativeRunBinding(pool, caller.userId, agent.id, harness, caller.scopeWorkspaceId, pinned?.bindingId)
      : pinned ? await subscriptionRuntime().repository.binding(caller.userId,pinned.bindingId) : await subscriptionRuntime().repository.nativeBinding(caller.userId, agent.id, harness) : null
  } catch { return NextResponse.json({ error:'Subscription unavailable.' },{ status:409 }) }
  if (pinned && (!subscription || subscription.id !== pinned.bindingId || subscription.modelId !== pinned.modelId || subscription.route !== pinned.route || subscription.consumerId !== agent.id || subscription.ownerId !== caller.userId)) return NextResponse.json({ error:'Pinned subscription unavailable.' },{ status:409 })
  if (subscription && !device.harnesses.some(info => info.harness === harness && info.subscriptionBroker)) return NextResponse.json({ error: 'Subscription requires a broker-enabled hosted runner.' }, { status: 409 })
  let cliPolicy: Awaited<ReturnType<typeof readCliRunPolicy>>
  try { cliPolicy = await readCliRunPolicy(pool, runId, caller.userId) }
  catch { return NextResponse.json({ error: 'Agent policy unavailable.' }, { status: 409 }) }
  const leaseExpiresAt = new Date(Date.now() + RUN_LEASE_MS).toISOString()
  let factoryClaim: Record<string, unknown> = {}
  let factoryToken: Awaited<ReturnType<typeof issueRunToken>> | undefined
  const beforeClaim = async (tx: import('pg').PoolClient) => {
    if (process.env.MIKKA_FACTORY_ROUTING_ENABLED !== '1' || process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED !== '1') return true
    const { guardFactoryClaim } = await import('@/lib/factory/runtime')
    try { factoryClaim = await guardFactoryClaim(tx,caller.userId,deviceId,runId,leaseExpiresAt); return true }
    catch (error) { if (error instanceof FactoryError) return false; throw error }
  }
  const afterClaim = async (tx: import('pg').PoolClient) => {
    if (factoryClaim.preserveQuestionWorktree === true) {
      const { withDatabaseClient } = await import('@/lib/db')
      factoryToken = await withDatabaseClient(tx, () => issueRunToken(run))
    }
  }
  let computer: Awaited<ReturnType<typeof claimCloudRun>> = null
  let publication: Awaited<ReturnType<typeof import('@/lib/run-publications')['prepareRunPublication']>> | null = null
  let localComputer: Awaited<ReturnType<typeof localComputerAuthority>> = null
  let taskEnv: Record<string, string> = {}
  if (device.kind === 'cloud') {
    if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1' || caller.scopeDeviceId !== deviceId || !caller.scopeWorkspaceId || !subscription || subscription.workspaceId !== caller.scopeWorkspaceId || !device.harnesses.some(info => info.harness === harness && info.computerBroker)) return NextResponse.json({ error: 'Cloud computer worker unavailable.' }, { status: 409 })
    // 4e3: the task's explicit user variables (workspace + this repo's secrets/env). Resolved before the
    // claim so a decrypt failure leaves the run queued. Flag off = {}. Only cloud workers get it.
    if (byoE2BKeyEnabled(process.env)) {
      try { taskEnv = await taskSecretEnv(caller.scopeWorkspaceId, remoteRepositoryRef(repo.remoteUrl)) }
      catch { return NextResponse.json({ error: 'Workspace secrets unavailable.' }, { status: 409 }) }
    }
    computer = await claimCloudRun(pool, { userId: caller.userId, workspaceId: caller.scopeWorkspaceId }, runId, deviceId, new Date(leaseExpiresAt), subscription.id, beforeClaim, afterClaim)
    if (!computer) return NextResponse.json({ error: 'Cloud computer run unavailable.' }, { status: 409 })
  } else {
    const { prepareRunPublication, persistRunCompletion } = await import('@/lib/run-publications')
    try { publication = await prepareRunPublication(run, repo.remoteUrl!) }
    catch (error) {
      if (!(error instanceof PublicationError)) throw error
      await persistRunCompletion(caller.userId, runId, { stopReason: 'error', report: { summary: error.message, filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null } })
      after(async () => { const { wakeCoordinator } = await import('@/lib/coordinator/wake'); await wakeCoordinator(caller.userId) })
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 })
    }
    const claim = await claimLocalRun(pool, runId, deviceId, new Date(leaseExpiresAt), subscription?.id, beforeClaim, afterClaim)
    if (claim !== 'claimed') return NextResponse.json({ error: claim === 'cloud-required' ? 'Cloud computer worker required.' : 'Run is no longer queued for this device.' }, { status: 409 })
  }
  if (device.kind !== 'cloud' && device.computerUse?.installed) {
    const current = await localComputerAuthority(pool, caller.userId, deviceId, runId)
    if (current && (!caller.scopeWorkspaceId || caller.scopeWorkspaceId === current.workspaceId)) localComputer = current
  }
  let skillAssignment
  let benchmarkAssignment
  try {
    skillAssignment = await skillAssignments.recordClaim(caller.userId, deviceId, runId, leaseExpiresAt, supportsSkillArtifacts)
    benchmarkAssignment = await claimBenchmarkAssignment(caller.userId, deviceId, runId, leaseExpiresAt)
  } catch (error) {
    await db.update(agentRuns).set({ status: 'failed', stopReason: 'blocked', error: 'Skill assignment provenance unavailable.', finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, caller.userId), eq(agentRuns.status, 'preparing'), eq(agentRuns.leaseExpiresAt, new Date(leaseExpiresAt))))
    await afterRunEnded(caller.userId, runId)
    if (!(error instanceof ImprovementError)) throw error
    return NextResponse.json({ error: error.code }, { status: 409 })
  }
  // Tool provisioning is best effort, but it never authorizes the response.
  // A retirement during this await must still suppress the prompt below.
  const mcp = await (factoryToken ? Promise.resolve(factoryToken) : issueRunToken(run))
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
  const settings = device.kind === 'local' && repo.remoteUrl ? await readRepositorySettings(caller.userId, repo.remoteUrl) : null
  // A repository grant resolves its push approval, while an explicit CLI deny
  // or read-only ceiling remains authoritative for every execution tool.
  const executionPolicy = publication && !cliPolicy.policy.readOnly && cliPolicy.policy.permissions.git_push !== 'deny'
    ? { ...cliPolicy.policy, permissions: { ...cliPolicy.policy.permissions, git_push: publication.policy.permissions.git_push } }
    : cliPolicy.policy
  const computerPermission = computer?.permission ?? localComputer?.permission
  // Computer authority comes from its persisted claim; retain every trusted
  // CLI restriction and its revision when attaching that independent grant.
  const policy = computerPermission
    ? { ...executionPolicy, permissions: { ...executionPolicy.permissions, computer_use: executionPolicy.readOnly ? 'deny' as const : computerPermission } }
    : executionPolicy
  let assignmentPolicy: typeof policy
  try { assignmentPolicy = constrainedAssignmentPolicy(policy, benchmarkAssignment?.policy ?? factoryClaim.policy) }
  catch {
    const { persistRunCompletion } = await import('@/lib/run-publications')
    await persistRunCompletion(caller.userId, runId, { stopReason: 'error', report: { summary: 'Frozen execution policy no longer fits the current owner policy.', filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null } }, caller.scopeDeviceId)
    return NextResponse.json({ error: 'Frozen execution policy is no longer permitted.' }, { status: 409 })
  }
  const response = await authorizedClaimResponse(caller.userId, run, leaseExpiresAt, current => NextResponse.json({
    ...publication,
    runId, issueId: run.issueId, deviceId, repoId: repo.id,
    ...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl, expectedRepoRemote: repo.remoteUrl } : {}),
    ...(run.baseBranch ? { baseBranch: run.baseBranch } : {}), harness, prompt: current.prompt,
    kind: current.kind, leaseExpiresAt, policyRevision: cliPolicy.revision,
    ...(runTestFixture(harness) ? { fixture: runTestFixture(harness) } : {}),
    ...((device.kind === 'cloud' ? repo.verifyCommand : settings?.verifyCommand) ? { verifyCommand: (device.kind === 'cloud' ? repo.verifyCommand : settings?.verifyCommand)! } : {}),
    ...(mcp ? { mcp } : {}),
    ...(subscription ? { model: subscription.modelId, subscriptionBinding: { bindingId: subscription.id, ownerId: subscription.ownerId, workspaceId: subscription.workspaceId, consumerId: subscription.consumerId, route: subscription.route } } : {}),
    ...(computer ? { computer: { botId: computer.botId, ownerId: computer.ownerId, display: computer.display, policyVersion: computer.policyVersion } } : {}),
    ...(localComputer ? { localComputer } : {}),
    ...(Object.keys(taskEnv).length ? { taskEnv } : {}),
    ...retry,
    ...factoryClaim,
    ...skillAssignment,
    ...benchmarkAssignment,
    policy: assignmentPolicy,
  }))
  return response ?? NextResponse.json({ error: 'Run access changed before claim response.' }, { status: 409 })
}
