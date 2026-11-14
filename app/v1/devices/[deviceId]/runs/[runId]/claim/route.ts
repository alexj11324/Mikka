import { TASK_MCP_HEADER, TASK_MCP_VERSION, type TaskMcpServer } from '@mikka/protocol'
import { withFactoryQuestionDeliveryContext } from '@/lib/factory/questions/continuation-delivery-context'
import { deploymentSwitch } from '@/lib/deployment-switches'
import { CodedError, causeFields, logCodedError } from '@mikka/protocol/coded-error'
import { serverRunFailure } from '@/lib/run-failure-details'
import { cloudComputerTasksEnabled } from '@/lib/cloud-computer-flag'
import { withDeviceRoute } from '@/lib/device-route'
import { runListChanged } from '@/lib/live/lists'
import { NextResponse } from 'next/server'
import { afterJob } from '@/lib/background'
import { and, eq, isNull } from 'drizzle-orm'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { applyApprovalMode } from '@mikka/protocol/agent-policy'
import { readRepositorySettings } from '@/lib/device-repositories'
import { daemonTestMode, repositoryBindingMatches } from '@mikka/protocol/repository'
import { localExecutionHarnesses } from '@/lib/device-agents'
import { runTestFixture } from '@/lib/run-test-fixture'
import { MIN_DAEMON_VERSION, RUN_LEASE_MS, REPO_ORIGIN_HEADER, PROJECT_ENVIRONMENT_HEADER, RECOVERY_WORKTREE_HEADER, MODEL_CREDENTIAL_HEADER, RUN_CREDENTIALS_HEADER, INITIAL_REPOSITORY_HEADER, deviceRepoSchema, runModelCredentialSchema, type RunModelCredential } from '@mikka/protocol/device'
import { SUBSCRIPTION_MODEL_CATALOGUE_HEADER, type NativeLease } from '@mikka/protocol/subscription'
import { POLICY_SNAPSHOT_HEADER, POLICY_SNAPSHOT_VERSION } from '@mikka/protocol/policy-snapshot'
import { issuePolicySnapshot, policyDistributionContext } from '@/lib/agent-tool-approval/policy-distribution'
import { requestDevicePolicyIssuer } from '@/lib/agent-tool-approval/local-cloud-issuer'
import { readCliRunPolicy } from '@/lib/agent-tool-approval/policy-store'
import { assertUnmanagedModelTransport, assertSubscriptionModelTransport } from '@/lib/model-admission/runtime'
import { ModelAdmissionError } from '@/lib/model-admission/contract'
import { db, pool } from '@/lib/db'
import { runChanged } from '@/lib/live/panels'
import { agentRuns, agents, deviceRepos } from '@/lib/db/schema'
import { authenticateDevice, ownedDeviceWithReport } from '@/lib/device-link'
import { withBasePath } from '@/lib/base-path'
import { mcpResourceURL } from '@/lib/mcp/resource'
import { issueRunToken } from '@/lib/mcp/worker'
import { RUN_DECISION_CATALOGUE } from '@/lib/project-map/mcp-tool'
import { issueForUser } from '@/lib/issue-access'
import { failRunForDaemonUpgrade, failQueuedSubscriptionRuntime, latestCheckpoint } from '@/lib/run-leases'
import { subscriptionPreflightSchema } from '@mikka/protocol/harness'
import messages from '@/messages/zh-CN.json'
import { continuationFollowUp } from '@/lib/thread-continuation'
import { checkpointRecoveryError, providerContinuationNote, quotaContinuationNote, retryNote } from '@/lib/run-retry'
import { constrainedAssignmentPolicy, intersectRunPolicy } from '@/lib/run-assignment-policy'
import { localComputerAuthority } from '@/lib/computer/local-authority'
import { SKILL_ARTIFACT_HEADER, TEAM_SKILL_HEADER } from '@mikka/protocol/skill'
import { profileSkillRunAssignment } from '@/lib/factory/agent-profile-skills'
import { claimBenchmarkAssignment, skillAssignments } from '@/lib/self-improvement/server'
import { ImprovementError } from '@/lib/self-improvement/contract'
import { claimCloudRun, claimLocalRun } from '@/lib/computer/claim'
import { AgentProfileAdmissionError, refreshProfileQuota } from '@/lib/factory/profile-admission'
import { profileNativeSessionMatches } from '@/lib/factory/profile-native-session'
import { nativeRunBinding } from '@/lib/computer/native-run-binding'
import { FactoryError } from '@/lib/factory/contract'
import { blockQuestionRetry } from '@/lib/factory/questions/retry'
import { afterRunEnded } from '@/lib/run-completion-effects'
import { subscriptionRuntime } from '@/lib/subscription-runtime'
import { leaseDevice } from '@/lib/subscription-native-device'
import { sharedNativeBinding } from '@/lib/personal-policy'
import { PublicationError } from '@/lib/run-publication-result'
import { githubMachineConfigured, githubMachineCredential } from '@/lib/github/machine-credential'
import { authorizedClaimResponse } from '@/lib/run-claim-response'
import { personalMailboxEnabled } from '@/lib/personal-mailbox-config'
import { remoteRepositoryRef, taskSecretInjection, taskSecretSnapshot, environmentSecretInjection, environmentSecretSnapshot, type TaskSecretInjection } from '@/lib/secrets/runtime'
import { issueTaskSecretAccess } from '@/lib/secrets/task-access'
import { TASK_SECRETS_HEADER, TASK_SECRETS_VERSION } from '@mikka/protocol/task-secrets'
import { executionMembersActive } from '@/lib/execution-identity'
import { cloudStartupPhases, cloudStartupRunAttributes, cloudStartupSpan } from '@/lib/computer/startup-tracing'
import { cloudStartupDiagnosticEnv } from '@/lib/computer/startup-diagnostics'
import { withRunProjectExecution } from '@/lib/project-resources/run-lease'
import { ActionFailureError } from '@/lib/action-error'

import { daemonTooOld, daemonVersions } from '@/lib/daemon-release'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/devices/:deviceId/runs/:runId/claim`: hands the daemon everything
 * it needs to run. 409 means the run is not queued for this device — the
 * daemon's `RunNotPinnedHereError`, and it stops asking.
 */
async function handlePOST(request: Request, { params }: { params: Promise<{ deviceId: string; runId: string }> }) {
  const { runId } = await params
  const attributes = cloudStartupRunAttributes(runId)
  return cloudStartupSpan('cloud.worker.claim', attributes, async () => {
    const timings = cloudStartupPhases(attributes, 'cloud.worker.claim')
    try { return await claimRun(request, { params }, timings) }
    finally { timings.end() }
  })
}

async function claimRun(request: Request, { params }: { params: Promise<{ deviceId: string; runId: string }> }, timings: ReturnType<typeof cloudStartupPhases>) {
  timings.next('authorize')
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId, runId } = await params
  if (caller.scopeDeviceId && caller.scopeDeviceId !== deviceId) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const device = await ownedDeviceWithReport(deviceId, caller.userId)
  if (!device) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  if ((device.kind === 'local' && (device.protocolVersion ?? 0) < DAEMON_PROTOCOL_VERSION) || daemonTooOld(device)) {
    await failRunForDaemonUpgrade(runId, deviceId, caller.userId)
    return NextResponse.json({ error: 'Upgrade the Mikka daemon before starting this thread.', code: 'daemonUpgradeRequired', protocolVersion: DAEMON_PROTOCOL_VERSION, minVersion: MIN_DAEMON_VERSION, daemonVersions: await daemonVersions() }, { status: 409 })
  }
  if (!device.enabled) return NextResponse.json({ error: 'Scheduling is off for this device.' }, { status: 409 })
  timings.next('identity')
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.deviceId, deviceId), eq(agentRuns.status, 'queued'), eq(agentRuns.userId, caller.userId), isNull(agentRuns.stopRequestedAt)))
    .limit(1)
  if (!run) return NextResponse.json({ error: 'Run is not queued for this device.' }, { status: 409 })
  if (run.agentDefinition?.customMcp?.servers.length && request.headers.get(TASK_MCP_HEADER) !== TASK_MCP_VERSION) {
    await failRunForDaemonUpgrade(runId,deviceId,caller.userId)
    return NextResponse.json({error:'Upgrade the Mikka daemon before using native MCP servers.',code:'daemonUpgradeRequired',protocolVersion:DAEMON_PROTOCOL_VERSION,minVersion:MIN_DAEMON_VERSION,daemonVersions:await daemonVersions()},{status:409})
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId)).limit(1)
  const [repo] = run.deviceRepoId
    ? await db.select().from(deviceRepos).where(eq(deviceRepos.id, run.deviceRepoId)).limit(1)
    : []
  if ((agent && agent.userId !== caller.userId) || (repo && (repo.userId !== caller.userId || repo.deviceId !== deviceId)))
    return NextResponse.json({ error: 'Run ownership unavailable.' }, { status: 409 })
  if (!agent || !repo || !run.issueId) {
    const failed = await db.update(agentRuns)
      .set({ status: 'failed', stopReason: 'error', failureDetails: serverRunFailure(runId, new Date()), error: 'Run is missing its agent, repository or issue.', finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRuns.id, runId)).returning({ id: agentRuns.id })
    if (failed.length) { await runListChanged(db, runId); await runChanged(db, runId) }
    await afterRunEnded(caller.userId, runId)
    return NextResponse.json({ error: 'Run is missing its agent, repository or issue.' }, { status: 409 })
  }
  if (run.userId !== caller.userId || agent.userId !== caller.userId || repo.userId !== caller.userId || repo.deviceId !== deviceId) return NextResponse.json({ error: 'Run owner mismatch.' }, { status: 409 })
  if (device.kind === 'local' && !repositoryBindingMatches(repo.repoPath, repo.remoteUrl, { allowFile: daemonTestMode(process.env) })) return NextResponse.json({ error: 'Repository identity must be confirmed before scheduling a new thread.' }, { status: 409 })
  if (repo.remoteUrl && request.headers.get(REPO_ORIGIN_HEADER) !== '1') return NextResponse.json({ error: 'Device update required for repository verification.' }, { status: 409 })
  const issueId = run.issueId
  const claimAuthorizedProject = async () => {
  const projectEnvironment = run.agentDefinition?.projectExecution?.environment
  if (projectEnvironment && request.headers.get(PROJECT_ENVIRONMENT_HEADER) !== '1') return NextResponse.json({ error: 'Device update required for the selected environment.', code: 'projectEnvironmentUnavailable' }, { status: 409 })
  const rejectProfile = async (error: AgentProfileAdmissionError) => {
    logCodedError(error, { runId })
    const summary = 'The selected Agent Profile changed or is no longer available. Select an available Profile for a new run.'
    // The claim transaction has rolled back. Only its still-unclaimed row may
    // be settled; a concurrent claim/stop must never be overwritten.
    const rejected = await db.update(agentRuns).set({ status: 'failed', stopReason: 'blocked', error: summary, failureDetails: serverRunFailure(runId, new Date(), new CodedError('run_failed', { cause: error })),
      report: { summary, filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null }, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, caller.userId), eq(agentRuns.deviceId, deviceId), eq(agentRuns.status, 'queued'), isNull(agentRuns.stopRequestedAt)))
      .returning({ id: agentRuns.id })
    if (rejected.length) await afterRunEnded(caller.userId, runId)
    return NextResponse.json({ error: summary, code: 'agentProfileUnavailable' }, { status: 409 })
  }
  const rejectPublication = async (error: PublicationError) => {
    const { persistRunCompletion } = await import('@/lib/run-publications')
    await persistRunCompletion(caller.userId, runId, { stopReason: 'error', report: { summary: error.message, filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null } })
    afterJob('after:coordinator-wake', async () => { const { wakeCoordinator } = await import('@/lib/coordinator/wake'); await wakeCoordinator(caller.userId) })
    return NextResponse.json({ error: error.message, code: error.code }, { status: 409 })
  }
  // Preserve the task-access denial before narrower policy parsing or any
  // claim preparation. Publication and the final response recheck it later.
  timings.next('admission')
  const claimIssue = await issueForUser(caller.userId, issueId)
  if (!claimIssue) return rejectPublication(new PublicationError('issue_unavailable'))
  // Task and Run ownership is persisted host data. Neither a claim token nor
  // an old frozen execution scope can assign the task to another workspace.
  if (!run.workspaceId || claimIssue.ownershipState !== 'bound' || claimIssue.workspaceId !== run.workspaceId
    || caller.scopeWorkspaceId && caller.scopeWorkspaceId !== run.workspaceId
    || run.agentDefinition?.executionIdentity !== undefined && run.agentDefinition.executionIdentity?.workspaceId !== run.workspaceId)
    return NextResponse.json({ error: 'Run ownership unavailable.' }, { status: 409 })
  // Historical generic retries cannot turn an original-session answer into
  // a fresh execution, even when their Factory attempt is no longer present.
  if (run.retryOf && await blockQuestionRetry(pool, caller.userId, issueId, runId) && (await afterRunEnded(caller.userId, runId), true)) return NextResponse.json({ error: 'Generic retry cannot replay an original-session question answer; explicit recovery required.' }, { status: 409 })
  const [lost] = run.retryOf
    ? await db.select({ sessionId: agentRuns.sessionId, deviceId: agentRuns.deviceId, agentId: agentRuns.agentId, stopReason: agentRuns.stopReason, agentDefinition: agentRuns.agentDefinition, report: agentRuns.report }).from(agentRuns)
      .where(and(eq(agentRuns.id, run.retryOf), eq(agentRuns.userId, caller.userId), issueId === null ? isNull(agentRuns.issueId) : eq(agentRuns.issueId, issueId))).limit(1)
    : []
  const providerCheckpointUnavailable = lost?.stopReason === 'provider_failure' && lost.report?.providerCheckpoint === 'unavailable'
  // A failed final upload supersedes any older patch. Only the original
  // worktree may continue; another device must never replay an older tree.
  const resumeFrom = run.retryOf && !providerCheckpointUnavailable ? await latestCheckpoint(run.retryOf) : null
  const recoveryError = run.retryOf
    ? providerCheckpointUnavailable ? 'A usable final recovery snapshot is unavailable. Continue in the original worktree.'
      : checkpointRecoveryError(resumeFrom) ?? (!resumeFrom ? 'No uploaded recovery snapshot is available.' : null)
    : null
  const requireWorktreeContinuation = Boolean(recoveryError && lost?.deviceId === deviceId && request.headers.get(RECOVERY_WORKTREE_HEADER) === '1')
  if (recoveryError && !requireWorktreeContinuation) {
    const { persistRunCompletion } = await import('@/lib/run-publications')
    await persistRunCompletion(caller.userId, runId, { stopReason: 'blocked', report: { summary: recoveryError, filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null } }, caller.scopeDeviceId)
    afterJob('after:coordinator-wake', async () => { const { wakeCoordinator } = await import('@/lib/coordinator/wake'); await wakeCoordinator(caller.userId) })
    return NextResponse.json({ error: recoveryError, code: 'checkpointRecoveryUnavailable' }, { status: 409 })
  }
  const supportsSkillArtifacts = request.headers.get(SKILL_ARTIFACT_HEADER) === '1'
  const supportsTeamSkills = request.headers.get(TEAM_SKILL_HEADER) === '1'
  const receivesRunCredentials = request.headers.get(RUN_CREDENTIALS_HEADER) === '1'
  try { await skillAssignments.preflight(caller.userId, runId, supportsSkillArtifacts, supportsTeamSkills) } catch (error) {
    if (!(error instanceof ImprovementError)) throw error
    return NextResponse.json({ error: error.code }, { status: error.code === 'notFound' ? 404 : 409 })
  }
  const harness = run.agentDefinition?.harness ?? agent.harness
  const pinned = run.agentDefinition?.subscription
  let subscription: Awaited<ReturnType<ReturnType<typeof subscriptionRuntime>['repository']['nativeBinding']>>
  try { subscription = deploymentSwitch('byos')
    ? run.agentDefinition && !pinned ? null : device.kind === 'cloud'
      ? await nativeRunBinding(pool, caller.userId, agent.id, harness, caller.scopeWorkspaceId, pinned?.bindingId)
      : pinned ? await nativeRunBinding(pool, caller.userId, agent.id, harness, undefined, pinned.bindingId) : await localRunBinding(caller.userId, agent.id, harness, run.botId ?? null) : null
  } catch { return NextResponse.json({ error:'Subscription unavailable.' },{ status:409 }) }
  if (pinned && (!subscription || subscription.id !== pinned.bindingId || subscription.modelId !== pinned.modelId || subscription.route !== pinned.route || subscription.consumerId !== agent.id)) return NextResponse.json({ error:'Pinned subscription unavailable.' },{ status:409 })
  if (subscription && !device.harnesses.some(info => info.harness === harness && info.installed && info.toolApproval && info.subscriptionBroker && !info.subscriptionPreflight)) {
    if (device.kind === 'local' && (harness === 'codex' || harness === 'claude_code')) {
      const info = device.harnesses.find(info => info.harness === harness)
      const detail = subscriptionPreflightSchema.safeParse(info?.subscriptionPreflight).data ?? (!info?.installed ? 'cli_missing' : 'adapter_start_failed')
      await failQueuedSubscriptionRuntime(runId, deviceId, caller.userId, { harness, bindingId: subscription.id })
      return NextResponse.json({ error: messages.RunErrors.subscription_local_runtime_unavailable[detail ?? 'default'], code: 'subscription_local_runtime_unavailable', ...(detail ? { detail } : {}) }, { status: 409 })
    }
    return NextResponse.json({ error: 'Subscription requires a broker-enabled hosted runner.' }, { status: 409 })
  }
  if (device.kind === 'local' && (!repo.remoteUrl || !localExecutionHarnesses(device.harnesses).includes(harness))) return NextResponse.json({ error: 'Repository or execution harness unavailable.' }, { status: 409 })
  if ((harness === 'codex' || harness === 'claude_code') && !device.harnesses.some(info => info.harness === harness && info.installed && info.toolApproval === true)) return NextResponse.json({ error: 'Run approval capability unavailable.' }, { status: 409 })
  // A run frozen on the person's API key goes only to a daemon that injects it; nothing is opened yet.
  const frozenKey = run.agentDefinition?.apiKey
  if (frozenKey && (subscription || pinned)) return NextResponse.json({ error: 'Run credential unavailable.' }, { status: 409 })
  if (frozenKey && request.headers.get(MODEL_CREDENTIAL_HEADER) !== '1') return NextResponse.json({ error: 'Upgrade the Mikka daemon before starting this thread.', code: 'daemonUpgradeRequired', protocolVersion: DAEMON_PROTOCOL_VERSION, daemonVersions: await daemonVersions() }, { status: 409 })
  let cliPolicy: Awaited<ReturnType<typeof readCliRunPolicy>>
  try {
    cliPolicy = await readCliRunPolicy(pool, runId, caller.userId)
    for (const workspaceId of Array.from(new Set([...cliPolicy.workspaceIds, ...(subscription ? [subscription.workspaceId] : [])]))) {
      const scope = { workspaceId, ownerId: caller.userId }
      const model = run.agentDefinition?.model ?? subscription?.modelId ?? 'native-default'
      if (subscription) await assertSubscriptionModelTransport(scope, model, subscription.route, request.signal)
      else await assertUnmanagedModelTransport(scope, model, request.signal)
    }
  }
  catch (error) { return NextResponse.json({ error: error instanceof ModelAdmissionError ? error.code : 'Agent policy unavailable.' }, { status: 409 }) }
  const snapshotCapability = request.headers.get(POLICY_SNAPSHOT_HEADER)
  if ((snapshotCapability !== null && snapshotCapability !== POLICY_SNAPSHOT_VERSION) || (cliPolicy.policySnapshotRequired && snapshotCapability !== POLICY_SNAPSHOT_VERSION)) return NextResponse.json({error:'Signed policy consumer required.',code:'policyConsumerUpgradeRequired'},{status:409})
  let distribution: ReturnType<typeof policyDistributionContext> | undefined
  if (snapshotCapability === POLICY_SNAPSHOT_VERSION) {
    try { distribution = policyDistributionContext(await requestDevicePolicyIssuer(request,caller,deviceId,runId),caller.userId,deviceId,runId,cliPolicy) }
    catch { return NextResponse.json({error:'Policy signing unavailable.'},{status:503}) }
  }
  timings.next('acquire_lease')
  const leaseExpiresAt = new Date(Date.now() + RUN_LEASE_MS).toISOString()
  let factoryClaim: Record<string, unknown> = {}
  let factoryToken: Awaited<ReturnType<typeof issueRunToken>> | undefined
  const beforeClaim = async (tx: import('pg').PoolClient) => {
    // Scope may change while publication/policy preparation awaits. Recheck the same frozen
    // binding, including both members and the share, before taking the lease.
    if (subscription && !await nativeRunBinding(tx, caller.userId, agent.id, harness, subscription.workspaceId, subscription.id)) return false
    if (!deploymentSwitch('factoryRouting') || !deploymentSwitch('factoryLifecycle')) return true
    const { guardFactoryClaim } = await import('@/lib/factory/runtime')
    try { factoryClaim = await guardFactoryClaim(tx,caller.userId,deviceId,runId,leaseExpiresAt); return true }
    catch (error) { if (error instanceof FactoryError) return false; throw error }
  }
  const afterClaim = async (tx: import('pg').PoolClient) => {
    await tx.query('UPDATE agent_runs SET "deviceTokenId"=$2,"machineAuthority"=$4 WHERE id=$1 AND "userId"=$3', [runId, caller.tokenId, caller.userId, receivesRunCredentials])
    if (factoryClaim.preserveQuestionWorktree === true) {
      const { withDatabaseClient } = await import('@/lib/db')
      factoryToken = await withDatabaseClient(tx, () => issueRunToken(run))
    }
  }
  // The key is opened here, at claim, for this run only (orchestration.md § 6): `apiKeyForRun` checks the
  // run is active and the key still usable by its owner in its workspace, and records the run so
  // withdrawing the key stops it. A key that is gone ends the run; it never switches credential.
  let modelCredential: RunModelCredential | undefined
  const openRunKey = async (): Promise<NextResponse | null> => {
    if (!frozenKey) return null
    const [{ apiKeyForRun }, { WorkspaceError }] = await Promise.all([import('@/lib/model-api-keys'), import('@/lib/workspace-error')])
    const refuse = async () => {
      const { persistRunCompletion } = await import('@/lib/run-publications')
      await persistRunCompletion(caller.userId, runId, { stopReason: 'blocked', report: { summary: 'API key unavailable.', filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null } }, caller.scopeDeviceId)
      afterJob('after:coordinator-wake', async () => { const { wakeCoordinator } = await import('@/lib/coordinator/wake'); await wakeCoordinator(caller.userId) })
      return NextResponse.json({ error: 'API key unavailable.', code: 'apiKeyUnavailable' }, { status: 409 })
    }
    let opened: Awaited<ReturnType<typeof apiKeyForRun>>
    // The run's Agent picks the key's endpoint; a key that does not serve it ends the run.
    if (harness !== 'claude_code' && harness !== 'codex') return refuse()
    try { opened = await apiKeyForRun(pool, runId, frozenKey.keyId, harness) }
    catch (error) {
      // Secrets briefly unreadable: the run stays queued. A key that is gone, or no longer usable here: the run ends.
      if (!(error instanceof WorkspaceError) || error.code !== 'apiKeyNotFound') return NextResponse.json({ error: 'API key unavailable.' }, { status: 409 })
      return refuse()
    }
    const parsed = opened.harness === harness ? runModelCredentialSchema.safeParse(opened.harness === 'claude_code'
      ? { kind: 'provider', protocol: 'anthropic', baseUrl: opened.env.ANTHROPIC_BASE_URL, key: opened.env.ANTHROPIC_API_KEY }
      : { kind: 'provider', protocol: 'openai', baseUrl: opened.codex.model_providers.mikka.base_url, key: opened.env.MIKKA_MODEL_API_KEY }) : null
    if (!parsed?.success) return refuse()
    modelCredential = parsed.data
    return null
  }
  let computer: Awaited<ReturnType<typeof claimCloudRun>> = null
  let publication: Awaited<ReturnType<typeof import('@/lib/run-publications')['prepareRunPublication']>> | null = null
  let localComputer: Awaited<ReturnType<typeof localComputerAuthority>> = null
  let taskEnv: Record<string, string> = {}
  let taskSecretNames: string[] = []
  const taskWorkspaceId = run.workspaceId
  const taskRepository = remoteRepositoryRef(repo.remoteUrl)
  if (projectEnvironment && (!taskWorkspaceId || taskWorkspaceId !== run.workspaceId
    || run.agentDefinition?.projectExecution?.workspaceId !== taskWorkspaceId)) return NextResponse.json({ error: 'Environment workspace unavailable.', code: 'projectEnvironmentUnavailable' }, { status: 409 })
  const cloudDesktop = device.kind === 'cloud' && device.harnesses.some(info => info.harness === harness && info.computerBroker)
  if (device.kind === 'cloud' && (!cloudComputerTasksEnabled() || !caller.scopeWorkspaceId || caller.scopeDeviceId !== deviceId
    || !(subscription ? subscription.workspaceId === caller.scopeWorkspaceId : frozenKey) || !cloudDesktop && !repo.remoteUrl
    || taskWorkspaceId && taskWorkspaceId !== caller.scopeWorkspaceId)) return NextResponse.json({ error: 'Cloud computer worker unavailable.' }, { status: 409 })
  let taskInjection: TaskSecretInjection
  try {
    taskInjection = projectEnvironment
      ? await environmentSecretInjection(taskWorkspaceId!, taskRepository, projectEnvironment, process.env, run.userId)
      : await taskSecretInjection(taskWorkspaceId, taskRepository, process.env, undefined, run.userId)
    taskEnv = taskInjection.env
    taskSecretNames = taskInjection.secretNames
  } catch { return NextResponse.json({ code: 'task_secret_unavailable', detail: 'configuration' }, { status: 409 }) }
  if ((taskInjection.protectedSecrets.length || taskInjection.unavailable.length)
    && request.headers.get(TASK_SECRETS_HEADER) !== TASK_SECRETS_VERSION) {
    await failRunForDaemonUpgrade(runId, deviceId, caller.userId)
    return NextResponse.json({ error: 'Upgrade the Mikka daemon before using protected task Secrets.', code: 'daemonUpgradeRequired', daemonVersions: await daemonVersions() }, { status: 409 })
  }
  if (device.kind === 'cloud') {
    // A task machine (E2B's claude or codex template, decision 2026-11-01-2335) has no desktop: its
    // worker reports no computer broker. It takes repository tasks only; a computer task stays queued.
    const desktop = cloudDesktop
    // A cloud run with a task branch gets its publication like a local run,
    // before the lease, so a refusal leaves it queued.
    if (run.agentDefinition?.repositoryAdmission && !run.agentDefinition.readOnly) {
      const { prepareRunPublication } = await import('@/lib/run-publications')
      try { publication = await prepareRunPublication(run, repo.remoteUrl!) }
      catch (error) {
        if (!(error instanceof PublicationError)) throw error
        return rejectPublication(error)
      }
    }
    const refused = await openRunKey()
    if (refused) return refused
    // Read-only checks inspect the retained files; they cannot use an
    // interactive desktop. Its policy must not gate their file-only claim.
    const useComputer = desktop && run.agentDefinition?.readOnly !== true
    let claimed: Awaited<ReturnType<typeof claimCloudRun>>
    try { claimed = await claimCloudRun(pool, { userId: caller.userId, workspaceId: caller.scopeWorkspaceId! }, runId, deviceId, new Date(leaseExpiresAt), subscription?.id ?? null, beforeClaim, afterClaim, useComputer) }
    catch (error) { if (error instanceof AgentProfileAdmissionError) return rejectProfile(error); throw error }
    if (!claimed) return NextResponse.json({ error: 'Cloud computer run unavailable.' }, { status: 409 })
    // Without a desktop the run gets none (the daemon refuses a `computer` it cannot serve).
    computer = useComputer ? claimed : null
  } else {
    // A read-only run (an investigation) publishes nothing: no task branch.
    if (!run.agentDefinition?.readOnly) {
      const { prepareRunPublication } = await import('@/lib/run-publications')
      try { publication = await prepareRunPublication(run, repo.remoteUrl!) }
      catch (error) {
        if (!(error instanceof PublicationError)) throw error
        return rejectPublication(error)
      }
    }
    const refused = await openRunKey()
    if (refused) return refused
    if (subscription) await refreshProfileQuota(pool, { ownerId: caller.userId, workspaceId: subscription.workspaceId, agentId: agent.id,
      model: run.agentDefinition?.model, subscriptionBindingId: subscription.id, selection: run.agentDefinition?.agentProfile })
    let claim: Awaited<ReturnType<typeof claimLocalRun>>
    try { claim = await claimLocalRun(pool, runId, deviceId, new Date(leaseExpiresAt), subscription?.id, beforeClaim, afterClaim) }
    catch (error) { if (error instanceof AgentProfileAdmissionError) return rejectProfile(error); throw error }
    if (claim !== 'claimed') return NextResponse.json({ error: claim === 'cloud-required' ? 'Cloud computer worker required.' : 'Run is no longer queued for this device.' }, { status: 409 })
  }
  if (device.kind !== 'cloud' && device.computerUse?.installed) {
    const current = await localComputerAuthority(pool, caller.userId, deviceId, runId)
    if (current && (!caller.scopeWorkspaceId || caller.scopeWorkspaceId === current.workspaceId)) localComputer = current
  }
  timings.next('provenance')
  let skillAssignment
  let benchmarkAssignment
  try {
    skillAssignment = await skillAssignments.recordClaim(caller.userId, deviceId, runId, leaseExpiresAt, supportsSkillArtifacts, supportsTeamSkills)
    benchmarkAssignment = await claimBenchmarkAssignment(caller.userId, deviceId, runId, leaseExpiresAt)
  } catch (error) {
    const failed = await db.update(agentRuns).set({ status: 'failed', stopReason: 'blocked', failureDetails: serverRunFailure(runId, new Date(), new CodedError('run_failed', { cause: error })), error: 'Skill assignment provenance unavailable.', finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, caller.userId), eq(agentRuns.status, 'preparing'), eq(agentRuns.leaseExpiresAt, new Date(leaseExpiresAt)))).returning({ id: agentRuns.id })
    if (failed.length) { await runListChanged(db, runId); await runChanged(db, runId) }
    await afterRunEnded(caller.userId, runId)
    if (!(error instanceof ImprovementError)) throw error
    return NextResponse.json({ error: error.code }, { status: 409 })
  }
  // A task machine receives its credentials once during preparation (#1505).
  // These existing credential lookups overlap the remaining claim setup. The
  // final claim-response transaction still checks the owner/run/device before
  // returning any prompt or credential. Older daemons keep their original
  // response shape until they advertise the capability.
  timings.next('assignment_context')
  const startupAttributes = cloudStartupRunAttributes(runId)
  const githubRepository = /^v2\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo.repoPath) && harness !== 'mock'
  // Resolve native configuration outside the optional hand-in-token catch. A
  // revoked connection must visibly fail the task, never remove all MCP tools.
  let servers: TaskMcpServer[] = []
  if (run.agentDefinition?.customMcp && ['claude_code','codex','cursor'].includes(harness)) {
    try { servers = await (await import('@/lib/plugins/runtime')).personalPlugins.nativeMcpConnections(caller.userId,run.agentDefinition.customMcp) }
    catch (error) {
      logCodedError(new CodedError('mcpUnavailable',{cause:error}),{runId:run.id})
      const now = new Date()
      await db.update(agentRuns).set({status:'failed',stopReason:'error',error:'mcpUnavailable',failureDetails:serverRunFailure(runId,now),finishedAt:now,updatedAt:now})
        .where(and(eq(agentRuns.id,run.id),eq(agentRuns.userId,caller.userId),eq(agentRuns.deviceId,deviceId),eq(agentRuns.status,'preparing')))
      await Promise.all([runListChanged(db,run.id),runChanged(db,run.id)])
      await afterRunEnded(caller.userId,run.id)
      return NextResponse.json({error:'MCP configuration unavailable.',code:'mcpUnavailable'},{status:409})
    }
  }
  const preparedCredentials = receivesRunCredentials ? Promise.allSettled([
    cloudStartupSpan('cloud.worker.claim.native_credentials', startupAttributes, async (): Promise<NativeLease | undefined> => {
      if (!subscription) return undefined
      if (!leaseDevice(device, deviceId, caller.scopeDeviceId)) throw new Error('Run credential device unavailable')
      const runtime = subscriptionRuntime(true, false, { exportAccessLease: true })
      return runtime.nativeLease(await runtime.nativeRun(caller.userId, deviceId, runId), request.signal,
        request.headers.get(SUBSCRIPTION_MODEL_CATALOGUE_HEADER) === '1')
    }),
    cloudStartupSpan('cloud.worker.claim.github_credentials', startupAttributes, async () => {
      if (!githubRepository || !await githubMachineConfigured(caller.userId)) return undefined
      const issued = await githubMachineCredential(caller.userId, { remoteKey: repo.repoPath })
      return { token: issued.token, expiresAt: issued.expiresAt?.toISOString() ?? null }
    }),
  ] as const) : undefined
  // Tool provisioning is best effort, but it never authorizes the response.
  // A retirement during this await must still suppress the prompt below.
  const mcp = await (factoryToken ? Promise.resolve(factoryToken) : issueRunToken(run))
      .then(async ({ token }) => {
        const tools = personalMailboxEnabled() ? await (await import('@/lib/personal-mailbox-runtime')).personalWorkerMailboxAdvertised(caller.userId, run.id) : []
        // Connected apps, one MCP entry each on the device; best effort, never blocking the run.
        let apps = harness === 'claude_code' || harness === 'codex'
          ? await (await import('@/lib/app-tools-server')).runAppToolkits(caller.userId, run.botId ?? null).catch(() => [])
          : []
        return { url: mcpResourceURL ?? new URL(withBasePath('/api/mcp'), request.url).toString(), token,
          decisionCatalogue: RUN_DECISION_CATALOGUE,
          mailboxCatalogue: { version: 1 as const, transport: 'mikka-stateless-2025-06-18' as const, tools },
          ...(tools.length ? { mailbox: true as const } : {}), ...(apps.length ? { apps } : {}), ...(servers.length ? { servers } : {}) }
      })
      .catch((error: unknown) => { if (servers.length) throw new CodedError('mcpUnavailable',{cause:error}); console.error('Could not issue a run token', { name:error instanceof Error ? error.name : typeof error }); return undefined })
  // A retry after a lost lease works on in the lost attempt's worktree and,
  // when the harness can, its session; the daemon falls back to `prompt`.
  // Another machine has no such worktree and starts from the latest
  // checkpoint instead.
  // Historical runs have no frozen definition. Only the same owned Agent
  // proves their harness; an unknown source on another Agent cannot resume.
  const retryHarness = lost?.agentDefinition?.harness
    ?? (lost?.agentDefinition == null && lost?.agentId === run.agentId ? agent.harness : undefined)
  const retry = run.retryOf
    ? {
      // A continuation after a used-up quota (lib/run-quota.ts) is told that, not a lost machine.
      continuesRunId: run.retryOf, followUp: lost?.stopReason === 'provider_failure' ? providerContinuationNote() : lost?.stopReason === 'quota_exhausted' ? quotaContinuationNote() : retryNote(run.attempt),
      // A fallback keeps the worktree across harnesses, but native session
      // identifiers belong only to the harness that created them.
      ...(lost?.sessionId && lost.deviceId === deviceId && retryHarness === harness && profileNativeSessionMatches(lost.agentDefinition, run.agentDefinition) ? { resumeSessionId: lost.sessionId } : {}),
      ...(resumeFrom && !requireWorktreeContinuation ? { resumeFrom } : {}),
      ...(requireWorktreeContinuation ? { requireWorktreeContinuation: true as const } : {}),
    }
    : {}
  // The next run of a thread after a new dispatch (lib/thread-dispatch.ts) goes on in the thread's last worktree and,
  // on the same device, its session, sent only the new note; elsewhere it starts fresh with the full brief.
  // A historical version keeps its conversation lineage but starts a fresh
  // native session and worktree. Resuming the latest session would leak later
  // turns back into the historical prefix or overwrite its working files.
  const version = !run.retryOf && run.continuesRunId && (await pool.query(
    'SELECT 1 FROM thread_reply_versions WHERE "resultRunId"=$1 AND "userId"=$2 AND "workspaceId"=$3',
    [run.id,caller.userId,run.workspaceId])).rowCount
  const [earlier] = !version && !run.retryOf && run.continuesRunId
    ? await db.select({ sessionId: agentRuns.sessionId, deviceId: agentRuns.deviceId, agentId: agentRuns.agentId, agentDefinition: agentRuns.agentDefinition }).from(agentRuns).where(and(eq(agentRuns.id, run.continuesRunId), eq(agentRuns.userId, caller.userId), eq(agentRuns.issueId, issueId))).limit(1)
    : []
  const earlierHarness = earlier?.agentDefinition?.harness ?? (earlier?.agentDefinition == null && earlier?.agentId === run.agentId ? agent.harness : undefined)
  const followUp = earlier ? run.agentDefinition?.workspaceReview
    ? await (await import('@/lib/coding-workspace/diff/feedback-brief')).reviewBatchFollowUp(pool, run)
    : continuationFollowUp(run.prompt) : null
  const threadContinuation = earlier && run.continuesRunId
    ? { continuesRunId: run.continuesRunId, ...(followUp ? { followUp } : {}), ...(earlier.sessionId && earlier.deviceId === deviceId && earlierHarness === harness && profileNativeSessionMatches(earlier.agentDefinition, run.agentDefinition) ? { resumeSessionId: earlier.sessionId } : {}) }
    : {}
  const settings = repo.remoteUrl ? await readRepositorySettings(caller.userId, repo.remoteUrl) : null
  const verifyCommand = settings ? settings.verifyCommand : device.kind === 'cloud' ? repo.verifyCommand : null
  // Whether the daemon itself pushes the verified task branch: a run with a
  // task branch does. The agent's own push is never withheld; it works with the
  // owner's own GitHub credential (decision 2026-11-02-1600). `ask` is never forwarded.
  const push = publication && !cliPolicy.policy.readOnly && publication.policy.permissions.git_push === 'allow' ? 'allow' as const : 'deny' as const
  const resolvedPolicy = { ...cliPolicy.policy, permissions: { ...cliPolicy.policy.permissions, git_push: push } }
  // A read-only run cannot change its worktree.
  const executionPolicy = run.agentDefinition?.readOnly ? applyApprovalMode(resolvedPolicy, 'read_only') : resolvedPolicy
  const computerPermission = computer?.permission ?? localComputer?.permission
  // Computer authority comes from its persisted claim; retain every trusted
  // CLI restriction and its revision when attaching that independent grant.
  const policy = computerPermission
    ? { ...executionPolicy, permissions: { ...executionPolicy.permissions, computer_use: executionPolicy.readOnly ? 'deny' as const : computerPermission } }
    : executionPolicy
  let assignmentPolicy: typeof policy
  try {
    // Publication/computer grants are composed above. They cannot restore a
    // capability the original provider execution explicitly withheld.
    assignmentPolicy = constrainedAssignmentPolicy(intersectRunPolicy(policy, run.agentDefinition?.policyCeiling), benchmarkAssignment?.policy ?? factoryClaim.policy)
  }
  catch {
    const { persistRunCompletion } = await import('@/lib/run-publications')
    await persistRunCompletion(caller.userId, runId, { stopReason: 'error', report: { summary: 'Frozen execution policy no longer fits the current owner policy.', filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null } }, caller.scopeDeviceId)
    return NextResponse.json({ error: 'Frozen execution policy is no longer permitted.' }, { status: 409 })
  }
  let subscriptionLease: NativeLease | undefined
  let githubCredential: { token: string; expiresAt: string | null } | undefined
  timings.next('credentials_wait')
  if (preparedCredentials) {
    const [native, github] = await preparedCredentials
    const failures = [native, github].filter(result => result.status === 'rejected')
    if (failures.length) {
      // A credential failure must not strand an already claimed run. Complete
      // only this claim's still-preparing lease, never a concurrent stop/retry.
      console.warn(JSON.stringify({ msg: 'run_claim_credentials_failed', runId,
        failures: failures.map(result => causeFields((result as PromiseRejectedResult).reason)) }))
      const failed = await db.update(agentRuns).set({ status: 'failed', stopReason: 'blocked', failureDetails: serverRunFailure(runId, new Date(), new CodedError('run_failed', { cause: (failures[0] as PromiseRejectedResult).reason })), error: 'Run credentials unavailable.', finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, caller.userId), eq(agentRuns.status, 'preparing'), eq(agentRuns.leaseExpiresAt, new Date(leaseExpiresAt)), isNull(agentRuns.stopRequestedAt))).returning({ id: agentRuns.id })
      if (failed.length) { await runListChanged(db, runId); await runChanged(db, runId); await afterRunEnded(caller.userId, runId) }
      return NextResponse.json({ error: 'Run credentials unavailable.' }, { status: 409, headers: { 'cache-control': 'private, no-store' } })
    }
    if (native.status === 'fulfilled') subscriptionLease = native.value
    if (github.status === 'fulfilled') githubCredential = github.value
  }
  const githubConnected = receivesRunCredentials ? Boolean(githubCredential)
    : repo.repoPath.startsWith('v2/github.com/') && await githubMachineConfigured(caller.userId)
  timings.next('response_fence')
  const response = await authorizedClaimResponse(caller.userId, run, leaseExpiresAt, current => {
    const taskSecrets = issueTaskSecretAccess({ injection: taskInjection,
      endpoint: new URL(withBasePath(`/v1/task-secrets/${runId}`), request.url).toString(), leaseExpiresAt,
      binding: { ownerId: current.userId, workspaceId: taskWorkspaceId, repository: taskRepository,
        runId: current.id, deviceId, deviceTokenId: caller.tokenId, attempt: current.attempt } })
    const assignedEnv = cloudStartupDiagnosticEnv(taskEnv, { deviceKind: device.kind, run: current,
      repository: remoteRepositoryRef(repo.remoteUrl), harness, subscriptionBindingId: subscription?.id })
    // Reuse the same owner/remote settings already read for this assignment.
    // No discovery, authorization or provider work is added inside the fence.
    const initialRepository = device.kind === 'cloud' && repo.remoteUrl &&
      !current.retryOf && !current.continuesRunId && !current.sessionId &&
      request.headers.get(INITIAL_REPOSITORY_HEADER) === '1'
      ? deviceRepoSchema.safeParse({ repoId: repo.id, path: repo.repoPath,
        name: repo.repoPath.split('/').filter(Boolean).pop() ?? repo.repoPath, remoteUrl: repo.remoteUrl,
        ...(settings?.setup ? { setup: settings.setup } : {}),
        ...(settings?.networkAllow ? { networkAllow: settings.networkAllow } : {}) }).data : undefined
    return NextResponse.json({
    ...publication,
    ...(initialRepository ? { repo: initialRepository } : {}),
    // Profile Skills: the frozen pinned bodies for the owner's daemon and the
    // repository names it pins from its own checkout. Only the daemon sees the
    // text; the brief carries metadata only.
    ...profileSkillRunAssignment(current.agentDefinition?.agentProfile?.skills ?? []),
    runId, issueId: run.issueId, deviceId, repoId: repo.id,
    ...(run.agentDefinition?.traceContext ? { traceContext: { ...run.agentDefinition.traceContext, runId } } : {}),
    ...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl, expectedRepoRemote: repo.remoteUrl } : {}),
    ...(run.baseBranch ? { baseBranch: run.baseBranch } : {}), harness, prompt: current.prompt,
    kind: current.kind, leaseExpiresAt, policyRevision: cliPolicy.revision,
    ...(runTestFixture(harness) ? { fixture: runTestFixture(harness) } : {}),
    ...(verifyCommand ? { verifyCommand } : {}),
    ...(mcp ? { mcp } : {}),
    // The owner's GitHub credential is ready for git and gh, including
    // read-only runs. The endpoint is retained for natural-expiry refresh.
    ...((mcp || githubCredential) && githubConnected && githubRepository
      ? { github: { endpoint: (mcp?.url ?? new URL(withBasePath('/api/mcp'), request.url).toString()).replace(/\/api\/mcp\/?$/, '/api/runs/github-token'), repository: repo.repoPath.slice('v2/github.com/'.length),
        ...githubCredential,
        ...(publication?.pushBranch && ['implement', 'fix'].includes(current.kind) && !assignmentPolicy.readOnly ? { branch: publication.pushBranch } : {}) } } : {}),
    ...(run.agentDefinition?.model ? {model:run.agentDefinition.model} : {}),
    ...((run.agentDefinition?.agentProfile?.effort ?? run.agentDefinition?.modelDispatch?.routing?.effort)
      ? { effort: run.agentDefinition?.agentProfile?.effort ?? run.agentDefinition?.modelDispatch?.routing?.effort } : {}),
    ...(modelCredential ? { modelCredential } : {}),
    ...(subscription ? { ...(run.agentDefinition?.cliModelSelection ? {} : {model:subscription.modelId}), subscriptionBinding: { bindingId: subscription.id, ownerId: subscription.ownerId, workspaceId: subscription.workspaceId, consumerId: subscription.consumerId, route: subscription.route } } : {}),
    ...(subscriptionLease ? { subscriptionLease } : {}),
    ...(computer && assignmentPolicy.permissions.computer_use !== 'deny' ? { computer: { botId: computer.botId, ownerId: computer.ownerId, display: computer.display, policyVersion: computer.policyVersion } } : {}),
    ...(localComputer ? { localComputer } : {}),
    ...(projectEnvironment ? { projectEnvironment: { id: projectEnvironment.id, revision: projectEnvironment.revision, ...(projectEnvironment.setup ? { setup: projectEnvironment.setup } : {}) } } : {}),
    ...(Object.keys(assignedEnv).length ? { taskEnv: assignedEnv } : {}),
    ...(taskSecretNames.length ? { taskSecretNames } : {}),
    ...(taskSecrets ? { taskSecrets } : {}),
    ...threadContinuation,
    ...retry,
    ...withFactoryQuestionDeliveryContext(factoryClaim, {
      issueId: run.issueId, kind: current.kind, readOnly: assignmentPolicy.readOnly,
      gitPush: assignmentPolicy.permissions.git_push,
      repository: githubConnected && githubRepository ? repo.repoPath.slice('v2/github.com/'.length) : undefined,
      branch: publication?.pushBranch, baseBranch: run.baseBranch ?? undefined,
    }),
    ...skillAssignment,
    ...benchmarkAssignment,
    policy: assignmentPolicy,
    ...(distribution ? {policySnapshotRequired:distribution.required,policySnapshot:issuePolicySnapshot(distribution,assignmentPolicy)} : {}),
    }, { headers: { 'cache-control': 'private, no-store' } })
  }, async (current, tx) => {
    const currentEnvironment = current.agentDefinition?.projectExecution?.environment
    const workspaceId = current.workspaceId
    if (!workspaceId || workspaceId !== taskWorkspaceId || current.deviceTokenId !== caller.tokenId || current.attempt !== run.attempt
      || current.agentDefinition?.executionIdentity?.workspaceId !== run.agentDefinition?.executionIdentity?.workspaceId
      || current.agentDefinition?.executionIdentity !== undefined && current.agentDefinition.executionIdentity?.workspaceId !== workspaceId
      || caller.scopeWorkspaceId && caller.scopeWorkspaceId !== workspaceId) return false
    if (Boolean(currentEnvironment) !== Boolean(projectEnvironment) || currentEnvironment &&
      (currentEnvironment.id !== projectEnvironment?.id || currentEnvironment.revision !== projectEnvironment?.revision
        || current.agentDefinition?.projectExecution?.workspaceId !== workspaceId)) return false
    if (taskInjection.snapshot === undefined) return true
    if (workspaceId && !current.agentDefinition?.executionIdentity && !await executionMembersActive(workspaceId, [current.userId])) return false
    const [currentRepo] = await tx.select({ remoteUrl: deviceRepos.remoteUrl }).from(deviceRepos).where(eq(deviceRepos.id, repo.id)).limit(1)
    if (!currentRepo || remoteRepositoryRef(currentRepo.remoteUrl) !== taskRepository) return false
    try {
      const snapshot = currentEnvironment && workspaceId
        ? await environmentSecretSnapshot(workspaceId, taskRepository, currentEnvironment, current.userId, tx)
        : await taskSecretSnapshot(workspaceId, taskRepository, current.userId, tx)
      return snapshot === taskInjection.snapshot
    } catch (error) {
      if (error instanceof CodedError && error.code === 'task_secret_unavailable') return false
      throw error
    }
  })
  return response ?? NextResponse.json({ error: 'Run access changed before claim response.' }, { status: 409 })
  }
  if (!run.workspaceId) {
    return NextResponse.json({ error: 'Run ownership unavailable.' }, { status: 409, headers: { 'cache-control': 'private, no-store' } })
  }
  try {
    return await withRunProjectExecution({ userId: caller.userId, workspaceId: run.workspaceId, issueId: run.issueId,
      repositoryKey: repo.remoteUrl ? repo.repoPath : null, baseBranch: run.baseBranch, runtime: device.kind === 'cloud' ? 'cloud' : 'local',
      harness: run.agentDefinition?.harness ?? agent.harness }, run.agentDefinition?.projectExecution, claimAuthorizedProject)
  } catch (error) {
    if (!(error instanceof ActionFailureError)) throw error
    if (error.code === 'workspaceAccessDenied') {
      // Resource admission runs before the existing task read. Preserve that
      // read's public denial while issuing no lease, token or completion.
      const unavailable = new PublicationError('issue_unavailable')
      return NextResponse.json({ error: unavailable.message, code: unavailable.code }, { status: 409, headers: { 'cache-control': 'private, no-store' } })
    }
    return NextResponse.json({ error: error.code, code: error.code }, { status: 409, headers: { 'cache-control': 'private, no-store' } })
  }
}

export const POST = withDeviceRoute(handlePOST)

/**
 * The run owner's own subscription, else one another member shares in the
 * run's workspace with 分享给团队成员 (orchestration.md §2). The device then
 * takes that run's access lease; the share is checked again on every lease.
 */
async function localRunBinding(userId: string, agentId: string, harness: string, botId: string | null) {
  const repository = subscriptionRuntime().repository
  const own = await repository.nativeBinding(userId, agentId, harness)
  if (own || !botId) return own
  const { rows: [bot] } = await pool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 AND "archivedAt" IS NULL', [botId, userId])
  if (!bot) return null
  const id = await sharedNativeBinding(pool, userId, agentId, harness, bot.workspaceId)
  if (!id) return null
  const { rows: [row] } = await pool.query<{ ownerId: string }>('SELECT "ownerId" FROM byos_bindings WHERE id=$1', [id])
  return row ? repository.binding(row.ownerId, id) : null
}
