import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test, { mock } from 'node:test'
import { gzipSync } from 'node:zlib'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { CodedError } from '@mikka/protocol/coded-error'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { REPO_ORIGIN_HEADER, PROJECT_ENVIRONMENT_HEADER, RECOVERY_WORKTREE_HEADER, RUN_CREDENTIALS_HEADER, type RunCheckpoint } from '@mikka/protocol/device'
import { SUBSCRIPTION_MODEL_CATALOGUE_HEADER } from '@mikka/protocol/subscription'
import { normalizeRepository } from '@mikka/protocol/repository'
import { SKILL_ARTIFACT_HEADER } from '@mikka/protocol/skill'
import { POLICY_SNAPSHOT_HEADER } from '@mikka/protocol/policy-snapshot'
import { TASK_SECRETS_HEADER, TASK_SECRETS_VERSION } from '@mikka/protocol/task-secrets'
import { policyDistributionContext } from '../lib/agent-tool-approval/policy-distribution'
import { verifyPolicySnapshot } from '@mikka/protocol/node-policy-snapshot'
import { POST } from '../app/v1/devices/[deviceId]/runs/[runId]/claim/route'
import { overrideDeploymentSwitch } from '../lib/deployment-switches'
import { AgentProfileAdmissionError } from '../lib/factory/profile-admission'
import { AgentProfileError } from '../lib/factory/agent-profile-definition'
import type { ProjectExecutionSnapshot } from '../lib/project-resources/contracts'
import type { ProjectExecutionInput } from '../lib/project-resources/store'
import { resolveAppOrigin } from '../lib/auth-config'
import { withBasePath } from '../lib/base-path'
import { openEgressCapability, EGRESS_CAPABILITY_TTL_MS } from '../lib/secrets/egress-capability'
import type { TaskSecretInjection } from '../lib/secrets/runtime'
import type { ExecutionIdentity } from '../lib/execution-identity'

const workspaceId = '53100000-0000-4000-8000-000000000002'
const claimRequestURL = 'http://127.0.0.1/mikka/v1/devices/device/runs/run/claim'
function fixture() {
  const repository = normalizeRepository('https://github.com/synthetic/claim-fixture.git')
  const probe = {
    workspace: { id: workspaceId, kind: 'team', ownerId: 'owner' },
    run: { id:'run',userId:'member',workspaceId,issueId:'issue',agentId:'agent',deviceId:'device',deviceRepoId:'repo',botId:null,attempt:1,baseBranch:null as string|null,status:'queued',prompt:'private claim instructions',kind:'implement',retryOf:null as string|null,stopReason:null as string|null,stopRequestedAt:null as Date|null,leaseExpiresAt:null as Date|null },
    issue: {id:'issue',userId:'owner',workspaceId,ownershipState:'bound',scope:'workspace',linearSyncPolicy:'explicit',linearSyncBlocked:false,content:{type:'doc'}},
    device: {id:'device',ownerId:'member',enabled:true,kind:'local',protocolVersion:DAEMON_PROTOCOL_VERSION,harnesses:[{harness:'codex',installed:true,toolApproval:true}]},
    agent: {id:'agent',userId:'member',deviceId:'device',harness:'codex'},
    repo: {id:'repo',userId:'member',deviceId:'device',baseBranch:'main',repoPath:repository.key,remoteUrl:repository.remoteUrl},
    // The CLI layer as resolveTrustedRunPolicy builds it: an unset git_push does not restrict the App grant.
    cliPolicy: {revision:'a'.repeat(64),policy:{...defaultRunPolicy(),permissions:{...defaultRunPolicy().permissions,git_push:'allow' as const}},workspaceIds:[] as string[],workspaceId:null,hierarchy:undefined,policySnapshotRequired:false,layers:{workspace:{}}},
    policyCapability:undefined as string|undefined,
    publication: {pushBranch:'synthetic-claim-branch',policy:defaultRunPolicy()},
    checkpoint: null as RunCheckpoint | null,
    strictRecovery: false,
    lost: undefined as {deviceId:string;sessionId:string;agentId:string;agentDefinition?:{harness?:'codex'|'claude_code'}|null}|undefined,
    preparation:[] as string[],
    modelAdmissionCalls:[] as {scope:{workspaceId:string;ownerId:string};model:string}[],
    subscriptionAdmissionCalls:[] as {scope:{workspaceId:string;ownerId:string};model:string;route:string}[],
    memberAllowed:true,questionRetryBlocked:false,tokenError:false,locks:[] as string[],transactions:0,transactionErrors:[] as Error[],beforeToken:undefined as (()=>Promise<void>)|undefined,
    appActive: 0, appCheckouts: 0, appReleases: 0,
    issueAccessError: undefined as Error | undefined,
    credentialCapability: false,
    catalogueCapability: false,
    secretCapability: undefined as string | undefined,
    secretInjection: undefined as Partial<TaskSecretInjection> | undefined,
    secretSnapshot: undefined as string | undefined,
    secretReads: [] as unknown[][],
    secretSnapshotReads: [] as unknown[][],
    membershipReads: [] as unknown[][],
    workspaceMemberAllowed: true,
    nativeLeaseCapabilities: [] as boolean[],
    ownNativeBinding: null,
    localBindingLookups: [] as string[][],
    cloudGitHubConfigured: false,
    cloudGitHubLookups: [] as string[],
    cloudGitHubCredentials: [] as string[][],
    mailboxLookups: [] as string[][],
    appToolkits: [] as string[],
    appToolkitLookups: [] as (string | null)[][],
    credentialOwners: [] as string[],
    credentialFailure: undefined as Error | undefined,
    beforeCredential: undefined as (() => Promise<void>) | undefined,
    environmentCapability: undefined as string | undefined,
    environmentInjection: undefined as TaskSecretInjection | undefined,
    environmentSnapshot: undefined as string | undefined,
    environmentSnapshotError: undefined as Error | undefined,
    environmentSnapshotReads: [] as unknown[][],
    environmentReads: [] as { workspaceId: string; repository: string | null; configuration: NonNullable<ProjectExecutionSnapshot['environment']>; ownerId: string }[],
    projectAdmission: { decision: 'allow' as 'allow' | 'projectRepositoryDenied' | 'projectEnvironmentUnavailable',
      calls: [] as { input: ProjectExecutionInput; frozen: ProjectExecutionSnapshot | undefined }[], active: false, operations: 0, releases: 0 },
  }
  Object.assign(globalThis,{claimResponseProbe:probe})
  return probe
}
async function claim(probe: ReturnType<typeof fixture>, preparation = ['skill-preflight','policy','secrets','publication','claim','skill-claim','benchmark-claim','token','settings'], expectsProjectAdmission = true) {
  const diagnostics: unknown[][] = []
  const errors = mock.method(console, 'error', (...args: unknown[]) => { diagnostics.push(args) })
  try { return await POST(new Request(claimRequestURL,{method:'POST',headers:{[REPO_ORIGIN_HEADER]:'1',[SKILL_ARTIFACT_HEADER]:'1',...(probe.strictRecovery ? {[RECOVERY_WORKTREE_HEADER]:'1'} : {}),...(probe.policyCapability?{[POLICY_SNAPSHOT_HEADER]:probe.policyCapability}:{}),...(probe.credentialCapability ? {[RUN_CREDENTIALS_HEADER]:'1'} : {}),...(probe.catalogueCapability ? {[SUBSCRIPTION_MODEL_CATALOGUE_HEADER]:'1'} : {}),...(probe.environmentCapability ? {[PROJECT_ENVIRONMENT_HEADER]:probe.environmentCapability} : {}),...(probe.secretCapability ? {[TASK_SECRETS_HEADER]:probe.secretCapability} : {})}}),{params:Promise.resolve({deviceId:'device',runId:'run'})}) }
  finally {
    errors.mock.restore()
    assert.deepEqual(diagnostics, probe.tokenError && probe.preparation.includes('token')
      ? [['Could not issue a run token', 'synthetic token refusal']] : [],
    'optional tool provisioning must not hide a missing fixture or unknown database operation')
    // Trace the intended gate: an unrelated failed prerequisite must not
    // masquerade as a successful lineage, scope or lease rejection.
    assert.deepEqual(probe.preparation,preparation)
    assert.equal(probe.appActive, 0, 'claim releases its APP client on success, refusal and retry')
    assert.equal(probe.appCheckouts, probe.appReleases, 'every APP checkout is released exactly once')
    assert.equal(probe.projectAdmission.calls.length, Number(expectsProjectAdmission), 'the claim validates its exact execution resource boundary')
    assert.equal(probe.projectAdmission.operations, Number(expectsProjectAdmission && probe.projectAdmission.decision === 'allow'), 'a refused resource never enters claim preparation')
    assert.equal(probe.projectAdmission.active, false, 'claim closes the resource lease on every path')
    assert.equal(probe.projectAdmission.releases, Number(expectsProjectAdmission))
  }
}

function selectEnvironment(probe: ReturnType<typeof fixture>, runtime: 'local' | 'cloud' = 'local') {
  const snapshot: ProjectExecutionSnapshot = {
    version: 1, workspaceId, projectId: '53100000-0000-4000-8000-000000000004', projectRevision: 3, policyRevision: 2,
    repositoryKey: probe.repo.repoPath, baseBranch: 'release/frozen-environment',
    environment: { id: '53100000-0000-4000-8000-000000000005', revision: 7, name: 'Claim fixture',
      runtime, harness: 'claude_code', setup: { copyFiles: ['config/example.json'], command: 'pnpm install --frozen-lockfile', approved: true },
      variables: { TASK_MODE: 'fixture' }, secretIds: ['53100000-0000-4000-8000-000000000006'], repositoryKeys: [probe.repo.repoPath] },
  }
  const definition = { harness: 'claude_code' as const, projectExecution: snapshot,
    subscription: undefined as { bindingId: string; modelId: string; route: 'claude_code_cli' } | undefined }
  Object.assign(probe.run, { baseBranch: snapshot.baseBranch, agentDefinition: definition })
  probe.device.harnesses = [{ harness: 'claude_code', installed: true, toolApproval: true }]
  probe.environmentInjection = { env: { TASK_MODE: 'fixture', SELECTED_SECRET: 'synthetic-selected-environment-value' }, secretNames: ['SELECTED_SECRET'], protectedSecrets: [], unavailable: [], snapshot: 'e'.repeat(64) }
  return { snapshot, definition }
}

function claimHistory(probe: ReturnType<typeof fixture>) {
  return structuredClone({ run: probe.run, issue: probe.issue, publication: probe.publication, checkpoint: probe.checkpoint })
}

test('resource refusal leaves the queued run and history unchanged without reading secrets or claiming', async () => {
  for (const denial of ['projectRepositoryDenied', 'projectEnvironmentUnavailable'] as const) {
    const probe = fixture()
    selectEnvironment(probe)
    probe.environmentCapability = '1'
    probe.credentialCapability = true
    probe.projectAdmission.decision = denial
    const before = claimHistory(probe)
    const response = await claim(probe, [])
    assert.equal(response.status, 409)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(await response.json(), { error: denial, code: denial })
    assert.deepEqual(claimHistory(probe), before)
    assert.deepEqual(probe.environmentReads, [])
    assert.deepEqual(probe.secretReads, [])
    assert.deepEqual(probe.credentialOwners, [])
    assert.equal(probe.appCheckouts, 0)
  }
})

test('an Environment requires the exact daemon capability before preparation, secrets or claim', async () => {
  for (const capability of [undefined, '2']) {
    const probe = fixture()
    selectEnvironment(probe)
    probe.environmentCapability = capability
    probe.credentialCapability = true
    const before = claimHistory(probe)
    const response = await claim(probe, [])
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'Device update required for the selected environment.', code: 'projectEnvironmentUnavailable' })
    assert.deepEqual(claimHistory(probe), before)
    assert.deepEqual(probe.environmentReads, [])
    assert.deepEqual(probe.secretReads, [])
    assert.deepEqual(probe.credentialOwners, [])
    assert.equal(probe.appCheckouts, 0)
  }
})

test('allowed local and cloud claims send the frozen Environment recipe and selected secret names', async () => {
  const previousCloud = process.env.MIKKA_CLOUD_COMPUTER_TASKS
  process.env.MIKKA_CLOUD_COMPUTER_TASKS = '1'
  overrideDeploymentSwitch('byos', true)
  try {
    for (const runtime of ['local', 'cloud'] as const) {
      const probe = fixture()
      const { snapshot, definition } = selectEnvironment(probe, runtime)
      const frozen = structuredClone(definition)
      probe.environmentCapability = '1'
      if (runtime === 'cloud') {
        definition.subscription = { bindingId: 'environment-binding', modelId: 'claude-haiku-5-5', route: 'claude_code_cli' }
        Object.assign(probe, { caller: { userId: 'member', scopeDeviceId: 'device', scopeWorkspaceId: workspaceId },
          cloud: { subscription: { id: definition.subscription.bindingId, workspaceId, modelId: definition.subscription.modelId, route: definition.subscription.route, consumerId: 'agent' } } })
        Object.assign(probe.device, { kind: 'cloud', harnesses: [{ harness: 'claude_code', installed: true, toolApproval: true, subscriptionBroker: true }] })
      }
      const response = await claim(probe, runtime === 'cloud'
        ? ['skill-preflight', 'policy', 'model-admission', 'environment-secrets', 'claim', 'skill-claim', 'benchmark-claim', 'token', 'settings', 'environment-snapshot']
        : ['skill-preflight', 'policy', 'environment-secrets', 'publication', 'claim', 'skill-claim', 'benchmark-claim', 'token', 'settings', 'environment-snapshot'])
      assert.equal(response.status, 200, runtime)
      const body = await response.json()
      assert.equal(body.baseBranch, 'release/frozen-environment')
      assert.equal(body.harness, 'claude_code', 'the frozen harness takes precedence over the current Agent')
      assert.deepEqual(body.projectEnvironment, { id: snapshot.environment!.id, revision: 7, setup: snapshot.environment!.setup })
      assert.deepEqual(body.taskEnv, probe.environmentInjection!.env)
      assert.deepEqual(body.taskSecretNames, ['SELECTED_SECRET'])
      assert.deepEqual(probe.environmentReads, [{ workspaceId, repository: 'synthetic/claim-fixture', configuration: snapshot.environment, ownerId: probe.run.userId }])
      assert.deepEqual(probe.secretReads, [], 'selected Environment never reads the unrestricted task secret collection')
      assert.deepEqual(probe.projectAdmission.calls, [{ input: { userId: 'member', workspaceId, issueId: 'issue', repositoryKey: probe.repo.repoPath,
        baseBranch: 'release/frozen-environment', runtime, harness: 'claude_code' }, frozen: snapshot }])
      assert.deepEqual(definition.projectExecution, frozen.projectExecution, 'claim never rewrites the historical Environment snapshot')
      assert.equal(probe.run.status, 'preparing')
      assert.ok(probe.run.leaseExpiresAt)
      assert.equal(Object.hasOwn(body.projectEnvironment, 'secretIds'), false)
    }
  } finally {
    overrideDeploymentSwitch('byos', undefined)
    if (previousCloud === undefined) delete process.env.MIKKA_CLOUD_COMPUTER_TASKS
    else process.env.MIKKA_CLOUD_COMPUTER_TASKS = previousCloud
  }
})

test('revoked task access keeps issue_unavailable ahead of policy and claim preparation', async () => {
  const probe = fixture()
  probe.memberAllowed = false
  const response = await claim(probe, ['issue-unavailable'])
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'The task is no longer available to this thread.', code: 'issue_unavailable' })
  assert.equal(probe.run.status, 'queued')
  assert.equal(probe.run.leaseExpiresAt, null)
})

test('a failed local subscription preflight ends the queued claim before policy, leases or credentials', async () => {
  overrideDeploymentSwitch('byos', true)
  try {
    for (const detail of ['env_not_clean', 'cli_missing', 'cli_version_mismatch', 'adapter_start_failed'] as const) {
      const probe = fixture()
      Object.assign(probe.run, { agentDefinition: { harness: 'codex', subscription: { bindingId: 'binding', modelId: 'fixture-model', route: 'codex_cli' } } })
      Object.assign(probe, { cloud: { subscription: { id: 'binding', modelId: 'fixture-model', route: 'codex_cli', consumerId: 'agent', workspaceId } } })
      Object.assign(probe.device.harnesses[0], { installed: detail !== 'cli_missing', subscriptionBroker: true, subscriptionPreflight: detail })
      const response = await claim(probe, ['skill-preflight', 'subscription-preflight'])
      assert.equal(response.status, 409)
      const body = await response.json()
      assert.equal(body.code, 'subscription_local_runtime_unavailable')
      assert.equal(body.detail, detail)
      assert.doesNotMatch(body.error, /subscription_local_runtime_unavailable|env_not_clean|cli_missing|cli_version_mismatch|adapter_start_failed/)
      assert.equal(probe.run.status, 'failed')
      assert.equal(probe.run.leaseExpiresAt, null)
      assert.equal(probe.preparation.includes('token'), false)
    }
  } finally { overrideDeploymentSwitch('byos', undefined) }
})

test('task access database errors are not misclassified as a permission denial', async () => {
  const probe = fixture(), failure = new Error('synthetic task access database fault')
  probe.issueAccessError = failure
  await assert.rejects(() => claim(probe, []), error => error === failure)
})
function validCheckpoint(): RunCheckpoint {
  return {baseCommit:'a'.repeat(40),patch:gzipSync(Buffer.alloc(0)).toString('base64'),files:0,takenAt:new Date().toISOString()}
}

test('historical question retries stop before publication, leases or worker credentials',async()=>{
  const probe=fixture();probe.run.retryOf='strict-question-parent';probe.questionRetryBlocked=true
  const response=await claim(probe,['question-retry'])
  assert.equal(response.status,409)
  assert.equal(probe.run.status,'failed');assert.equal(probe.run.stopReason,'blocked')
  assert.equal(probe.run.leaseExpiresAt,null)
  const body=await response.json()
  for(const field of ['prompt','mcp','skills','skillReceipt'])assert.equal(Object.hasOwn(body,field),false)
})

test('native claims check both stored Bot and task workspace model limits before leases or credentials',async()=>{
  const probe=fixture()
  probe.cliPolicy.workspaceIds=['bot-workspace','task-workspace']
  Object.assign(probe,{modelAdmissionDeniedWorkspace:'task-workspace'})
  const response=await claim(probe,['skill-preflight','policy','model-admission','model-admission'])
  assert.equal(response.status,409)
  assert.equal((await response.json()).error,'modelRouteDenied')
  assert.equal(probe.run.status,'queued')
  assert.equal(probe.run.leaseExpiresAt,null)
  assert.deepEqual((probe as typeof probe & {modelAdmissionScopes:unknown[]}).modelAdmissionScopes,[
    {workspaceId:'bot-workspace',ownerId:'member'},{workspaceId:'task-workspace',ownerId:'member'},
  ])
  assert.deepEqual(probe.modelAdmissionCalls, probe.cliPolicy.workspaceIds.map(workspaceId => ({scope:{workspaceId,ownerId:'member'},model:'native-default'})))
})

test('ordinary retries retain the normal claim path after question lineage validation',async()=>{
  const probe=fixture();probe.run.retryOf='ordinary-parent'
  probe.checkpoint=validCheckpoint()
  const response=await claim(probe,['question-retry','checkpoint','skill-preflight','policy','secrets','publication','claim','skill-claim','benchmark-claim','token','settings'])
  assert.equal(response.status,200)
  assert.equal(probe.run.status,'preparing')
  assert.equal((await response.json()).continuesRunId,'ordinary-parent')
})

test('every github.com run of a connected owner gets the owner credential endpoint, read-only and plan runs included', async () => {
  overrideDeploymentSwitch('personalMailbox', false)
  overrideDeploymentSwitch('byos', true)
  try { for (const variant of ['implement', 'plan', 'readOnly'] as const) {
    const probe = fixture()
    if (variant === 'plan') probe.run.kind = 'plan'
    if (variant === 'readOnly') Object.assign(probe.run, { agentDefinition: { readOnly: true } })
    probe.cliPolicy.policy.permissions.git_push = 'deny' as never
    const response = await claim(probe, variant === 'readOnly' ? ['skill-preflight','policy','secrets','claim','skill-claim','benchmark-claim','token','settings'] : undefined)
    assert.equal(response.status, 200, variant)
    const body = await response.json()
    assert.ok(body.mcp, JSON.stringify(Object.keys(body)))
    assert.equal(body.github?.endpoint, body.mcp.url.replace(/\/api\/mcp\/?$/, '/api/runs/github-token'), variant)
    assert.equal(body.github?.repository, 'synthetic/claim-fixture', variant)
    assert.equal(Object.hasOwn(body.github, 'token'), false, 'legacy daemons keep their original strict response schema')
    assert.equal(body.github?.branch, variant === 'implement' ? 'synthetic-claim-branch' : undefined, variant)
    assert.deepEqual((probe as unknown as { githubLookups: string[] }).githubLookups, ['member'], 'only the run owner\'s connection is looked up')
    assert.deepEqual(probe.cloudGitHubLookups, ['member'])
    assert.deepEqual(probe.localBindingLookups, variant === 'readOnly' ? [] : [['member', 'agent', 'codex']], 'legacy unpinned runs read only their own subscription metadata')
  } } finally { overrideDeploymentSwitch('personalMailbox', undefined); overrideDeploymentSwitch('byos', undefined) }
})

test('an owner without a GitHub connection gets no credential endpoint', async () => {
  const probe = fixture()
  Object.assign(probe, { githubAccountId: null })
  const response = await claim(probe)
  assert.equal(response.status, 200)
  assert.equal(Object.hasOwn(await response.json(), 'github'), false)
})

test('a capable daemon receives the owner GitHub credential once even without optional MCP provisioning', async () => {
  for (const tokenError of [false, true]) {
    const probe = fixture()
    probe.credentialCapability = true
    probe.tokenError = tokenError
    const response = await claim(probe)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const body = await response.json()
    assert.equal(body.github.token, 'fixture-claim-github-token')
    assert.equal(body.github.expiresAt, '2030-01-01T00:00:00.000Z')
    // MCP uses the configured service origin; a refused optional token falls
    // back to this claim's request URL. Neither expectation comes from body.
    const endpointOrigin = tokenError ? claimRequestURL : resolveAppOrigin(process.env) || claimRequestURL
    assert.equal(body.github.endpoint, new URL(withBasePath('/api/runs/github-token'), endpointOrigin).toString())
    assert.equal(Boolean(body.mcp), !tokenError, 'only the intentional token failure omits optional MCP')
    assert.deepEqual(probe.mailboxLookups, tokenError ? [] : [['member', 'run']])
    assert.deepEqual(probe.appToolkitLookups, tokenError ? [] : [['member', null]])
    assert.deepEqual(probe.credentialOwners, ['member'])
    assert.deepEqual(probe.cloudGitHubCredentials, [['member', probe.repo.repoPath]], 'the existing selector receives the exact Run repository before the OAuth fallback')
    assert.equal((probe.run as typeof probe.run & { machineAuthority: boolean }).machineAuthority, true)
  }
})

test('a stop during credential preparation suppresses every prepared secret and prompt', async () => {
  const probe = fixture()
  probe.credentialCapability = true
  probe.beforeCredential = async () => { probe.run.stopRequestedAt = new Date() }
  const response = await claim(probe)
  assert.equal(response.status, 409)
  assert.doesNotMatch(await response.text(), /fixture-claim-github-token|private claim instructions|subscriptionLease/)
  assert.deepEqual(probe.credentialOwners, ['member'])
})

test('credential preparation failure ends its claimed run without exposing credential diagnostics', async () => {
  const probe = fixture()
  probe.credentialCapability = true
  probe.credentialFailure = new Error('private-provider-credential-detail')
  const response = await claim(probe)
  assert.equal(response.status, 409)
  assert.equal(probe.run.status, 'failed')
  assert.equal(probe.run.stopReason, 'blocked')
  assert.doesNotMatch(await response.text(), /private-provider|fixture-claim|prompt|subscriptionLease/)
})

test('known unavailable or stale recovery blocks before leases, worker credentials or an old-client assignment', async () => {
  for (const unavailable of [true, false]) {
    const probe=fixture();probe.run.retryOf='lost-parent'
    probe.lost={deviceId:'device',sessionId:'old-machine-session',agentId:'agent',agentDefinition:null}
    probe.checkpoint={baseCommit:'a'.repeat(40),patch:'synthetic-empty-snapshot',files:1,
      takenAt:new Date(Date.now()-(unavailable ? 0 : 31*60_000)).toISOString(),
      ...(unavailable ? {unavailableReason:'too_large' as const} : {})}
    const response=await claim(probe,['question-retry','checkpoint','blocked-recovery'])
    assert.equal(response.status,409)
    assert.equal(probe.run.status,'stopped')
    assert.equal(probe.run.leaseExpiresAt,null)
    const body=await response.json()
    assert.equal(body.code,'checkpointRecoveryUnavailable')
    for(const field of ['resumeFrom','prompt','mcp','github'])assert.equal(Object.hasOwn(body,field),false)
  }
})

test('legacy retries of the same Agent retain their session only on the same device', async () => {
  for(const sameDevice of [true,false]) {
    const probe=fixture();probe.run.retryOf='lost-parent'
    probe.checkpoint=validCheckpoint()
    probe.lost={deviceId:sameDevice ? 'device' : 'old-device',sessionId:'old-machine-session',agentId:'agent',agentDefinition:null}
    const response=await claim(probe,['question-retry','checkpoint','skill-preflight','policy','secrets','publication','claim','skill-claim','benchmark-claim','token','settings'])
    assert.equal(response.status,200)
    const body=await response.json()
    assert.equal(body.continuesRunId,'lost-parent')
    assert.equal(body.resumeSessionId,sameDevice ? 'old-machine-session' : undefined)
    assert.deepEqual(body.resumeFrom,probe.checkpoint)
    assert.equal(body.requireWorktreeContinuation,undefined)
  }
})

test('strict legacy same-Agent continuation can use its original worktree without a usable snapshot',async()=>{
  for(const snapshot of ['missing','stale','unavailable'] as const) {
    const probe=fixture();probe.run.retryOf='lost-parent';probe.strictRecovery=true
    probe.lost={deviceId:'device',sessionId:'original-session',agentId:'agent',agentDefinition:null}
    if(snapshot!=='missing')probe.checkpoint={...validCheckpoint(),...(snapshot==='stale' ? {takenAt:new Date(Date.now()-31*60_000).toISOString()} : {unavailableReason:'too_large' as const})}
    const response=await claim(probe,['question-retry','checkpoint','skill-preflight','policy','secrets','publication','claim','skill-claim','benchmark-claim','token','settings'])
    assert.equal(response.status,200)
    const body=await response.json()
    assert.equal(body.requireWorktreeContinuation,true)
    assert.equal(body.continuesRunId,'lost-parent')
    assert.equal(body.resumeSessionId,'original-session')
    assert.equal(body.resumeFrom,undefined)
  }
})

test('frozen retry harnesses take precedence and an unrecorded different Agent cannot supply a native session',async()=>{
  for(const source of [
    {agentId:'agent',agentDefinition:{harness:'codex' as const},resumes:true},
    {agentId:'agent',agentDefinition:{harness:'claude_code' as const},resumes:false},
    {agentId:'other-agent',agentDefinition:{harness:'codex' as const},resumes:true},
    {agentId:'other-agent',agentDefinition:null,resumes:false},
    {agentId:'agent',agentDefinition:{},resumes:false},
  ]) {
    const probe=fixture();probe.run.retryOf='lost-parent';probe.checkpoint=validCheckpoint()
    probe.lost={deviceId:'device',sessionId:'source-session',agentId:source.agentId,agentDefinition:source.agentDefinition}
    const response=await claim(probe,['question-retry','checkpoint','skill-preflight','policy','secrets','publication','claim','skill-claim','benchmark-claim','token','settings'])
    assert.equal(response.status,200)
    const body=await response.json()
    assert.equal(body.harness,'codex')
    assert.equal(body.resumeSessionId,source.resumes ? 'source-session' : undefined,JSON.stringify(source))
    assert.equal(body.continuesRunId,'lost-parent')
    assert.deepEqual(body.resumeFrom,probe.checkpoint,'a different harness can continue from the worktree snapshot without reusing the native session')
  }
})

test('a missing snapshot blocks cross-device recovery and legacy clients before issuing a lease or token',async()=>{
  for(const [sameDevice,strictRecovery] of [[false,true],[false,false],[true,false]]) {
    const probe=fixture();probe.run.retryOf='lost-parent';probe.strictRecovery=strictRecovery
    probe.lost={deviceId:sameDevice ? 'device' : 'old-device',sessionId:'original-session',agentId:'agent',agentDefinition:null}
    const response=await claim(probe,['question-retry','checkpoint','blocked-recovery'])
    assert.equal(response.status,409)
    assert.equal(probe.run.leaseExpiresAt,null)
    assert.equal((await response.json()).code,'checkpointRecoveryUnavailable')
  }
})

test('claim committed before membership revocation cannot return its old prompt when token issuance fails',async()=>{
  const probe=fixture()
  probe.beforeToken=async()=>{
    probe.memberAllowed=false
    probe.tokenError=true
  }
  const response=await claim(probe)
  assert.equal(response.status,409)
  const body=await response.text()
  for(const privateField of ['private claim instructions','prompt','subscriptionBinding','synthetic-only'])assert.equal(body.includes(privateField),false)
  assert.equal(probe.run.status,'preparing')
  assert.ok(probe.run.leaseExpiresAt)
  assert.deepEqual(probe.locks,['workspaces','workspace_members'])
})

test('token provisioning failure alone still permits a currently authorized claim',async()=>{
  const probe=fixture();probe.tokenError=true
  const response=await claim(probe)
  assert.equal(response.status,200)
  const body=await response.json()
  assert.equal(body.prompt,probe.run.prompt);assert.equal(body.mcp,undefined)
  assert.equal(body.policyRevision,probe.cliPolicy.revision)
  assert.equal(body.pushBranch,probe.publication.pushBranch)
  assert.deepEqual(probe.locks,['workspaces','workspace_members','issues','agent_runs'])
})

test('a successful token does not override membership, task tenant or claim lease fences',async()=>{
  for(const change of ['membership','lease','workspace','ownership']){
    const probe=fixture()
    probe.beforeToken=async()=>{
      if(change==='membership')probe.memberAllowed=false
      else if(change==='lease')probe.run.leaseExpiresAt=new Date(Date.now()+600_000)
      else if(change==='workspace')probe.issue.workspaceId='53100000-0000-4000-8000-000000000003'
      else probe.issue.ownershipState='pending'
    }
    const response=await claim(probe)
    assert.equal(response.status,409)
    assert.equal((await response.text()).includes('prompt'),false)
  }
})

test('disabling provider sync preserves an authorized claim in the same task workspace',async()=>{
  const probe=fixture()
  probe.beforeToken=async()=>{probe.issue.linearSyncPolicy='disabled';probe.issue.linearSyncBlocked=true}
  const response=await claim(probe)
  assert.equal(response.status,200)
  assert.equal((await response.json()).prompt,probe.run.prompt)
  assert.equal(probe.issue.workspaceId,workspaceId)
  assert.equal(probe.run.workspaceId,workspaceId)
  assert.deepEqual(probe.locks,['workspaces','workspace_members','issues','agent_runs'])
})

test('authorized response uses the locked run rather than the initial snapshot',async()=>{
  const probe=fixture()
  probe.beforeToken=async()=>{probe.run.prompt='current authorized instructions'}
  const response=await claim(probe)
  assert.equal(response.status,200)
  assert.equal((await response.json()).prompt,'current authorized instructions')
})

test('an owner STOP during token preparation fences the response even while its lease remains live',async()=>{
  const probe=fixture()
  probe.beforeToken=async()=>{probe.run.stopRequestedAt=new Date()}
  const response=await claim(probe)
  assert.equal(response.status,409)
  const body=await response.text()
  for(const field of ['private claim instructions','prompt','synthetic-only'])assert.equal(body.includes(field),false)
  assert.equal(probe.run.status,'preparing')
  assert.ok(probe.run.leaseExpiresAt)
  assert.deepEqual(probe.locks,['workspaces','workspace_members','issues','agent_runs'])
})

test('response authorization retries only rolled-back serialization or deadlock failures, with a bound',async()=>{
  for(const code of ['40P01','40001']){
    const probe=fixture()
    probe.transactionErrors.push(new Error('wrapped DB failure',{cause:{code}}))
    assert.equal((await claim(probe)).status,200)
    assert.equal(probe.transactions,2)
  }
  const exhausted=fixture(),deadlock=Object.assign(new Error('synthetic deadlock'),{code:'40P01'})
  exhausted.transactionErrors.push(deadlock,deadlock,deadlock)
  await assert.rejects(claim(exhausted),error=>error===deadlock)
  assert.equal(exhausted.transactions,3)
  const unexpected=fixture(),unknown=new Error('unexpected transaction failure')
  unexpected.transactionErrors.push(unknown)
  await assert.rejects(claim(unexpected),error=>error===unknown)
  assert.equal(unexpected.transactions,1)
})

test('4e3: a cloud claim reads the task secrets (workspace + repo scope) before the claim',async()=>{
  const saved={...process.env}
  Object.assign(process.env,{MIKKA_CLOUD_COMPUTER_TASKS:'1',MIKKA_BYOS_ENABLED:'1',MIKKA_BYO_E2B_KEY:'1'})
  try{
    const probe=fixture()
    Object.assign(probe,{caller:{userId:'member',scopeDeviceId:'device',scopeWorkspaceId:workspaceId},cloud:{subscription:{id:'binding',consumerId:'agent',workspaceId,route:'codex_cli',modelId:'fixture-subscription-model'}}})
    Object.assign(probe.device,{kind:'cloud',harnesses:[{harness:'codex',installed:true,toolApproval:true,computerBroker:true,subscriptionBroker:true}]})
    const response=await claim(probe,['skill-preflight','policy','model-admission','secrets','claim','skill-claim','benchmark-claim','token','settings'])
    assert.equal(response.status,200)
    assert.deepEqual(probe.subscriptionAdmissionCalls,[{scope:{workspaceId,ownerId:'member'},model:'fixture-subscription-model',route:'codex_cli'}])
  } finally { for(const key of ['MIKKA_CLOUD_COMPUTER_TASKS','MIKKA_BYOS_ENABLED','MIKKA_BYO_E2B_KEY'])if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key] }
})

test('a capable bound cloud daemon receives its real subscription lease in the initial claim', async () => {
  const keys = ['MIKKA_CLOUD_COMPUTER_TASKS', 'MIKKA_BYOS_ENABLED', 'MIKKA_BYO_E2B_KEY'] as const
  const saved = keys.map(key => process.env[key])
  Object.assign(process.env, { MIKKA_CLOUD_COMPUTER_TASKS: '1', MIKKA_BYOS_ENABLED: '1', MIKKA_BYO_E2B_KEY: '1' })
  try {
    const probe = fixture()
    probe.credentialCapability = true
    const nativeLease = { route: 'codex_cli', modelId: 'gpt-6-luna', revision: 1, accountId: 'fixture-account', accessToken: 'fixture-native-access', expiresAt: '2030-01-01T00:00:00.000Z' }
    Object.assign(probe, { nativeLease, caller: { userId: 'member', scopeDeviceId: 'device', scopeWorkspaceId: workspaceId }, cloud: { subscription: { id: 'binding', consumerId: 'agent', workspaceId, route: 'codex_cli', modelId: 'gpt-6-luna' } } })
    Object.assign(probe.device, { kind: 'cloud', harnesses: [{ harness: 'codex', installed: true, toolApproval: true, subscriptionBroker: true }] })
    const response = await claim(probe, ['skill-preflight', 'policy', 'model-admission', 'secrets', 'claim', 'skill-claim', 'benchmark-claim', 'token', 'settings'])
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.subscriptionLease, nativeLease)
    assert.equal(body.github.token, 'fixture-claim-github-token')
    assert.deepEqual((probe as typeof probe & { nativeRunCalls: string[][] }).nativeRunCalls, [['member', 'device', 'run']])
    assert.equal((probe as typeof probe & { nativeLeaseCalls: unknown[] }).nativeLeaseCalls.length, 1)
    assert.deepEqual(probe.nativeLeaseCapabilities, [false], 'older strict daemons do not receive extra lease fields')
  } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] })
  }
})

test('a capable cloud claim preserves prepared full-model catalogue evidence without another request', async () => {
  const keys = ['MIKKA_CLOUD_COMPUTER_TASKS', 'MIKKA_BYOS_ENABLED', 'MIKKA_BYO_E2B_KEY'] as const
  const saved = keys.map(key => process.env[key])
  Object.assign(process.env, { MIKKA_CLOUD_COMPUTER_TASKS: '1', MIKKA_BYOS_ENABLED: '1', MIKKA_BYO_E2B_KEY: '1' })
  try {
    const probe = fixture()
    probe.credentialCapability = true
    probe.catalogueCapability = true
    probe.agent.harness = 'claude_code'
    const nativeLease = { route: 'claude_code_cli', modelId: 'claude-haiku-5-5', revision: 1, accountId: 'fixture-account',
      accessToken: 'fixture-native-access', expiresAt: '2030-01-01T00:00:00.000Z', modelCatalogueVerified: true }
    Object.assign(probe, { nativeLease, caller: { userId: 'member', scopeDeviceId: 'device', scopeWorkspaceId: workspaceId },
      cloud: { subscription: { id: 'binding', consumerId: 'agent', workspaceId, route: 'claude_code_cli', modelId: 'claude-haiku-5-5' } } })
    Object.assign(probe.device, { kind: 'cloud', harnesses: [{ harness: 'claude_code', installed: true, toolApproval: true, subscriptionBroker: true, subscriptionModelCatalogue: true }] })
    const response = await claim(probe, ['skill-preflight', 'policy', 'model-admission', 'secrets', 'claim', 'skill-claim', 'benchmark-claim', 'token', 'settings'])
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).subscriptionLease, nativeLease)
    assert.deepEqual(probe.nativeLeaseCapabilities, [true])
    assert.equal((probe as typeof probe & { nativeLeaseCalls: unknown[] }).nativeLeaseCalls.length, 1)
  } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] })
  }
})

test('URL repository settings reach local and cloud claims; an explicit clear suppresses legacy cloud verification', async () => {
  const keys = ['MIKKA_CLOUD_COMPUTER_TASKS', 'MIKKA_BYOS_ENABLED', 'MIKKA_BYO_E2B_KEY'] as const
  const saved = keys.map(key => process.env[key])
  Object.assign(process.env, { MIKKA_CLOUD_COMPUTER_TASKS: '1', MIKKA_BYOS_ENABLED: '1', MIKKA_BYO_E2B_KEY: '1' })
  try {
    for (const cloud of [false, true]) {
      process.env.MIKKA_BYOS_ENABLED = cloud ? '1' : '0'
      for (const settings of [{ verifyCommand: 'pnpm verify' }, { verifyCommand: null }, null]) {
        const probe = fixture()
        Object.assign(probe, { repositorySettings: settings })
        Object.assign(probe.repo, { verifyCommand: 'legacy cloud command' })
        if (cloud) {
          Object.assign(probe, { caller: { userId: 'member', scopeDeviceId: 'device', scopeWorkspaceId: workspaceId }, cloud: { subscription: { id: 'binding', consumerId: 'agent', workspaceId, route: 'codex_cli', modelId: 'fixture-subscription-model' } } })
          Object.assign(probe.device, { kind: 'cloud', harnesses: [{ harness: 'codex', installed: true, toolApproval: true, computerBroker: true, subscriptionBroker: true }] })
        }
        const response = await claim(probe, cloud
          ? ['skill-preflight', 'policy', 'model-admission', 'secrets', 'claim', 'skill-claim', 'benchmark-claim', 'token', 'settings']
          : undefined)
        assert.equal(response.status, 200)
        const body = await response.json()
        assert.equal(body.verifyCommand, settings ? settings.verifyCommand ?? undefined : cloud ? 'legacy cloud command' : undefined)
        assert.deepEqual((probe as typeof probe & { settingsReads: unknown[][] }).settingsReads, [['member', probe.repo.remoteUrl]])
      }
    }
    const probe = fixture()
    Object.assign(probe, { caller: { userId: 'member', scopeDeviceId: 'device', scopeWorkspaceId: workspaceId }, cloud: { subscription: { id: 'binding', consumerId: 'agent', workspaceId, route: 'codex_cli', modelId: 'fixture-subscription-model' } } })
    Object.assign(probe.device, { kind: 'cloud', harnesses: [{ harness: 'codex', installed: true, toolApproval: true, computerBroker: true, subscriptionBroker: true }] })
    Object.assign(probe.repo, { remoteUrl: null, verifyCommand: 'private workspace command' })
    const response = await claim(probe, ['skill-preflight', 'policy', 'model-admission', 'secrets', 'claim', 'skill-claim', 'benchmark-claim', 'token'])
    assert.equal(response.status, 200)
    assert.equal((await response.json()).verifyCommand, 'private workspace command')
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  }
})


test('platform cloud claims inject the configured secret assignment with BYO off; an empty assignment stays omitted',async()=>{
  const keys=['MIKKA_CLOUD_COMPUTER_TASKS','MIKKA_BYOS_ENABLED','MIKKA_BYO_E2B_KEY','WORKSPACE_SECRETS_KEY'] as const
  const saved=keys.map(key=>process.env[key])
  Object.assign(process.env,{MIKKA_CLOUD_COMPUTER_TASKS:'1',MIKKA_BYOS_ENABLED:'1',MIKKA_BYO_E2B_KEY:'0',WORKSPACE_SECRETS_KEY:'1'.repeat(64)})
  try {
    for(const configured of [true,false]) {
      const probe=fixture()
      const injection=configured ? {env:{TASK_SECRET:'synthetic-task-value',TASK_MODE:'fixture'},secretNames:['TASK_SECRET']} : {env:{},secretNames:[]}
      if(!configured)delete process.env.WORKSPACE_SECRETS_KEY
      Object.assign(probe,{caller:{userId:'member',scopeDeviceId:'device',scopeWorkspaceId:workspaceId},cloud:{subscription:{id:'binding',consumerId:'agent',workspaceId,route:'codex_cli',modelId:'fixture-subscription-model'}},secretInjection:injection,secretReads:[]})
      Object.assign(probe.device,{kind:'cloud',harnesses:[{harness:'codex',installed:true,toolApproval:true,computerBroker:true,subscriptionBroker:true}]})
      const response=await claim(probe,['skill-preflight','policy','model-admission','secrets','claim','skill-claim','benchmark-claim','token','settings'])
      assert.equal(response.status,200)
      assert.deepEqual(probe.subscriptionAdmissionCalls,[{scope:{workspaceId,ownerId:'member'},model:'fixture-subscription-model',route:'codex_cli'}])
      const body=await response.json()
      assert.deepEqual(body.taskEnv,configured ? injection.env : undefined)
      assert.deepEqual(body.taskSecretNames,configured ? injection.secretNames : undefined)
      // The run owner's own secrets join the workspace's (decision 2026-11-02-2120): the claim passes run.userId.
      assert.deepEqual((probe as typeof probe & {secretReads:unknown[][]}).secretReads.map(args=>[args[0],args[1],args[4]]),[[workspaceId,'synthetic/claim-fixture',probe.run.userId]])
    }
    for(const denial of ['authentication','device-scope','workspace-scope'] as const) {
      const probe=fixture()
      Object.assign(probe,{caller:denial==='authentication' ? null : {userId:'member',scopeDeviceId:denial==='device-scope' ? 'foreign-device' : 'device',scopeWorkspaceId:'foreign-workspace'},cloud:{subscription:{id:'binding',consumerId:'agent',workspaceId,route:'codex_cli',modelId:'fixture-subscription-model'}},secretInjection:{env:{TASK_SECRET:'must-not-leave'},secretNames:['TASK_SECRET']}})
      Object.assign(probe.device,{kind:'cloud',harnesses:[{harness:'codex',installed:true,toolApproval:true,computerBroker:true,subscriptionBroker:true}]})
      // The persisted ownership gate rejects a conflicting caller before policy or Secret preparation.
      const response=await claim(probe,[],denial==='workspace-scope')
      assert.equal(response.status,denial==='authentication' ? 401 : denial==='device-scope' ? 404 : 409)
      assert.equal((await response.text()).includes('must-not-leave'),false)
      assert.ok(!probe.preparation.includes('secrets'))
      assert.equal(probe.run.status,'queued')
      assert.equal(probe.run.leaseExpiresAt,null)
      assert.deepEqual(probe.secretReads,[])
      assert.deepEqual(probe.secretSnapshotReads,[])
      assert.deepEqual(probe.credentialOwners,[])
      assert.deepEqual(probe.nativeLeaseCapabilities,[])
    }
  } finally {keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i]})}
})

test('managed policy rejects an incapable worker before publication, claims or credentials',async()=>{
  for(const capability of [undefined,'2']) {
    const probe=fixture();probe.cliPolicy.policySnapshotRequired=true;probe.policyCapability=capability
    const response=await claim(probe,['skill-preflight','policy'])
    assert.equal(response.status,409);assert.equal(probe.run.status,'queued');assert.equal(probe.run.leaseExpiresAt,null)
    assert.equal((await response.json()).code,'policyConsumerUpgradeRequired')
  }
})
test('capable workers receive the signed final composed policy, not the earlier CLI layer',async()=>{
  const before=process.env.BETTER_AUTH_SECRET;process.env.BETTER_AUTH_SECRET='isolated-claim-policy-signing-fixture-only'
  try {
    const probe=fixture();probe.policyCapability='1';probe.cliPolicy.policySnapshotRequired=true
    probe.publication.policy.permissions.git_push='deny'
    const response=await claim(probe),body=await response.json();assert.equal(response.status,200)
    const context=policyDistributionContext('http://127.0.0.1/mikka','member','device','run',probe.cliPolicy)
    const verified=verifyPolicySnapshot(body.policySnapshot,context,{runId:'run',deviceId:'device',revision:body.policyRevision,policy:body.policy})
    assert.equal(verified.payload.policy.permissions.git_push,'deny')
    assert.equal(probe.cliPolicy.policy.permissions.git_push,'allow','the CLI layer is unchanged by the claim')
    assert.equal(body.policySnapshotRequired,true)
  } finally {if(before===undefined)delete process.env.BETTER_AUTH_SECRET;else process.env.BETTER_AUTH_SECRET=before}
})


test('Profile model, source or version changes keep ancestry but start a fresh native session', async () => {
  const profile = { profileId: 'default', version: 1, digest: 'frozen-role', targetEntry: { id: 'first', harness: 'codex', model: 'gpt-6-luna', source: { kind: 'subscription', connectionId: 'source-a' } } }
  const definition = { harness: 'codex' as 'codex' | 'claude_code', model: 'gpt-6-luna', subscription: { bindingId: 'binding-a', modelId: 'gpt-6-luna', route: 'codex_cli' }, agentProfile: profile }
  overrideDeploymentSwitch('byos', true)
  try { for (const lineage of ['retry', 'thread'] as const) {
    for (const change of ['same', 'model', 'source', 'version', 'harness'] as const) {
      const probe = fixture()
      Object.assign(probe.run, { agentDefinition: structuredClone(definition), ...(lineage === 'retry' ? { retryOf: 'profile-parent' } : { continuesRunId: 'profile-parent' }) })
      probe.lost = { deviceId: 'device', sessionId: 'old-native-session', agentId: 'agent', agentDefinition: structuredClone(definition) }
      if (lineage === 'retry') probe.checkpoint = validCheckpoint()
      const target = (probe.run as typeof probe.run & { agentDefinition: typeof definition }).agentDefinition
      if (change === 'model') target.model = target.agentProfile.targetEntry.model = 'other-currently-authorized-model'
      if (change === 'source') { target.agentProfile.targetEntry.source.connectionId = 'source-b'; target.subscription.bindingId = 'binding-b' }
      if (change === 'version') target.agentProfile.version++
      if (change === 'harness') { target.harness = target.agentProfile.targetEntry.harness = 'claude_code'; target.subscription.route = 'claude_code_cli' }
      target.subscription.modelId = target.model
      Object.assign(probe, { cloud: { subscription: { id: target.subscription.bindingId, modelId: target.model, route: target.subscription.route, consumerId: 'agent', workspaceId } } })
      probe.device.harnesses = [{ harness: target.harness, installed: true, toolApproval: true, subscriptionBroker: true } as typeof probe.device.harnesses[number]]
      const preparation = ['skill-preflight','policy','model-admission','secrets','publication','claim','skill-claim','benchmark-claim','token','settings']
      if (lineage === 'retry') preparation.unshift('question-retry','checkpoint')
      const response = await claim(probe, preparation)
      assert.equal(response.status, 200, `${lineage}:${change}`)
      const body = await response.json()
      assert.equal(body.continuesRunId, 'profile-parent', `${lineage}:${change}`)
      assert.equal(body.resumeSessionId, change === 'same' ? 'old-native-session' : undefined, `${lineage}:${change}`)
    }
  } } finally { overrideDeploymentSwitch('byos', undefined) }
})

test('Profile claim rejection preserves its cause and safe diagnostic while fencing the queued row', async t => {
  const lines: string[] = []
  t.mock.method(console, 'warn', (line: string) => { lines.push(line) })
  for (const concurrentClaim of [false, true]) {
    const probe = fixture()
    const cause = new AgentProfileError('agentProfileModelUnavailable', 409, { detail: 'checking' })
    cause.message = 'PRIVATE_PROFILE instructions; Bearer synthetic-secret; private Skill content'
    const error = new AgentProfileAdmissionError({ detail: 'current_profile', cause })
    assert.equal(error.cause, cause)
    assert.equal(error.message, 'agentProfileUnavailable')
    Object.assign(probe, { claimError: error, ...(concurrentClaim ? { beforeUpdate: async () => {
      probe.run.status = 'preparing'; probe.run.leaseExpiresAt = new Date(Date.now() + 30_000)
    } } : {}) })
    const response = await claim(probe, ['skill-preflight', 'policy', 'secrets','publication', 'claim-rejected'])
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.code, 'agentProfileUnavailable')
    assert.equal(probe.run.status, concurrentClaim ? 'preparing' : 'failed')
    assert.equal(probe.run.stopReason, concurrentClaim ? null : 'blocked')
    assert.deepEqual((probe as typeof probe & { endedRuns?: unknown[] }).endedRuns ?? [], concurrentClaim ? [] : [{ ownerId: 'member', runId: 'run' }])
    if (!concurrentClaim) assert.equal(probe.run.leaseExpiresAt, null)
    const logged = JSON.parse(lines.at(-1)!)
    assert.equal(logged.runId, 'run'); assert.equal(logged.code, 'agentProfileUnavailable'); assert.equal(logged.detail, 'current_profile')
    assert.deepEqual(logged.causes, [{ name: 'AgentProfileError', code: 'agentProfileModelUnavailable', detail: 'checking' }])
    for (const secret of ['PRIVATE_PROFILE', 'synthetic-secret', 'private Skill', probe.run.prompt]) {
      assert.ok(!JSON.stringify(body).includes(secret))
      assert.ok(!lines.at(-1)!.includes(secret))
    }
    for (const field of ['prompt', 'mcp', 'skills', 'skillReceipt', 'modelCredential']) assert.equal(Object.hasOwn(body, field), false)
  }
  assert.equal(lines.length, 2)
})

const preparedClaim = ['skill-preflight', 'policy', 'secrets', 'publication', 'claim', 'skill-claim', 'benchmark-claim', 'token', 'settings']
const preparedCloudClaim = ['skill-preflight', 'policy', 'model-admission', 'secrets', 'claim', 'skill-claim', 'benchmark-claim', 'token', 'settings']

function protectedFixture() {
  const probe = fixture()
  const canary = `synthetic-claim-canary-${randomBytes(24).toString('hex')}`
  const secret = {
    id: 'protected-secret', revision: 'a'.repeat(64), name: 'VENDOR_KEY', kind: 'secret' as const, value: canary,
    delivery: { mode: 'protected' as const, http: { origin: 'https://api.example.com', header: 'authorization' as const,
      prefix: 'Bearer ', rules: [{ method: 'POST' as const, path: '/v1/messages', match: 'exact' as const }] } },
  }
  probe.secretCapability = TASK_SECRETS_VERSION
  probe.secretInjection = { env: { TASK_REGION: 'fixture' }, secretNames: [], protectedSecrets: [secret], unavailable: [], snapshot: 'a'.repeat(64) }
  return { probe, canary, secret }
}

function localExecutionIdentity(workspaceId: string | null): ExecutionIdentity {
  return { version: 1, requester: 'member', botId: null, botOwner: null, executionPrincipal: 'member', workspaceId,
    outputOwner: 'member', resourceBindings: [{ kind: 'device', id: 'device', ownerId: 'member', access: 'owner' }],
    billingAccount: { model: { kind: 'native_login', ownerId: 'member', resourceId: 'device', amount: 'provider_unknown' },
      runtime: { kind: 'local_device', ownerId: 'member', resourceId: 'device', amount: 'not_applicable' } },
    personalResourcePolicy: 'requester_only' }
}

test('the actual claim response carries an opaque sealed task grant bound to the locked run', async t => {
  const saved = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  t.after(() => { if (saved === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = saved })
  const { probe, canary, secret } = protectedFixture()
  const response = await claim(probe, [...preparedClaim, 'secret-snapshot'])
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const wire = await response.text(), body = JSON.parse(wire)
  for (const form of [canary, Buffer.from(canary).toString('base64')]) assert.equal(wire.includes(form), false)
  assert.deepEqual(body.taskEnv, { TASK_REGION: 'fixture' })
  assert.equal(body.taskSecretNames, undefined)
  assert.equal(body.modelCredential, undefined)
  assert.equal(body.subscriptionLease, undefined)
  assert.equal(body.taskSecrets.endpoint, 'http://127.0.0.1/v1/task-secrets/run')
  assert.deepEqual(body.taskSecrets.unavailable, [])
  assert.equal(body.taskSecrets.grants.length, 1)
  const grant = body.taskSecrets.grants[0]
  assert.deepEqual(Object.keys(grant).sort(), ['capability', 'expiresAt', 'name', 'origin'])
  const binding = { ownerId: 'member', workspaceId, repository: 'synthetic/claim-fixture', runId: 'run', deviceId: 'device', deviceTokenId: 'synthetic-device-token', attempt: 1 }
  const opened = openEgressCapability(grant.capability, binding)
  assert.equal(opened.secret, canary)
  assert.equal(opened.secretId, secret.id)
  assert.equal(opened.revision, secret.revision)
  assert.deepEqual(opened.http, secret.delivery.http)
  assert.ok(opened.expiresAt - opened.issuedAt <= EGRESS_CAPABILITY_TTL_MS)
  assert.ok(opened.expiresAt <= new Date(probe.run.leaseExpiresAt!).getTime())
  for (const mismatch of [{ ownerId: 'other' }, { workspaceId: 'other' }, { repository: 'other/repo' }, { runId: 'other' },
    { deviceId: 'other' }, { deviceTokenId: 'other' }, { attempt: 2 }]) {
    assert.throws(() => openEgressCapability(grant.capability, { ...binding, ...mismatch }), { code: 'task_secret_unavailable', detail: 'binding_mismatch' })
  }
  assert.deepEqual(probe.locks, ['workspaces', 'workspace_members', 'issues', 'agent_runs'])
  assert.deepEqual(probe.secretReads.map(args => [args[0], args[1], args[4]]), [[workspaceId, 'synthetic/claim-fixture', 'member']])
  assert.deepEqual(probe.secretSnapshotReads.map(args => args.slice(0, 3)), [[workspaceId, 'synthetic/claim-fixture', 'member']])
  assert.equal(typeof (probe.secretSnapshotReads[0][3] as { select: unknown }).select, 'function')
})

test('protected and unconfigured secrets refuse old daemons before lease, publication or credentials', async () => {
  for (const capability of [undefined, '2']) for (const unconfigured of [false, true]) {
    const { probe, canary } = protectedFixture()
    probe.secretCapability = capability
    if (unconfigured) probe.secretInjection = { env: {}, secretNames: [], protectedSecrets: [], unavailable: ['VENDOR_KEY'] }
    const response = await claim(probe, ['skill-preflight', 'policy', 'secrets', 'daemon-upgrade'])
    assert.equal(response.status, 409)
    const wire = await response.text(), body = JSON.parse(wire)
    assert.equal(body.code, 'daemonUpgradeRequired')
    assert.equal(wire.includes(canary), false)
    assert.equal(body.taskSecrets, undefined)
    assert.equal(body.taskEnv, undefined)
    assert.equal(probe.run.leaseExpiresAt, null)
    assert.equal(probe.run.status, 'failed')
    assert.deepEqual(probe.credentialOwners, [])
    assert.deepEqual(probe.secretSnapshotReads, [])
  }
})

test('final response authorization rejects changed secret metadata, repository, attempt and device token', async t => {
  const saved = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  t.after(() => { if (saved === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = saved })
  for (const change of ['revision', 'repository', 'attempt', 'device-token'] as const) {
    const { probe, canary } = protectedFixture()
    probe.credentialCapability = true
    probe.beforeToken = async () => {
      if (change === 'revision') probe.secretSnapshot = 'b'.repeat(64)
      if (change === 'repository') probe.repo.remoteUrl = 'https://github.com/other/repository.git'
      if (change === 'attempt') probe.run.attempt++
      if (change === 'device-token') Object.assign(probe.run, { deviceTokenId: 'rotated-device-token' })
    }
    const response = await claim(probe, [...preparedClaim, ...(change === 'revision' ? ['secret-snapshot'] : [])])
    assert.equal(response.status, 409, change)
    const wire = await response.text()
    for (const value of [canary, 'mikka-egress-v1.', 'fixture-claim-github-token', probe.run.prompt]) assert.equal(wire.includes(value), false, change)
    assert.deepEqual(probe.locks, ['workspaces', 'workspace_members', 'issues', 'agent_runs'])
    assert.deepEqual(probe.credentialOwners, ['member'])
    assert.equal(probe.secretSnapshotReads.length, change === 'revision' ? 1 : 0)
  }
})

test('a changed valid frozen workspace identity cannot release a grant prepared for the earlier workspace', async t => {
  const saved = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  t.after(() => { if (saved === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = saved })
  for (const changed of [false, true]) {
    const { probe, canary } = protectedFixture()
    Object.assign(probe.run, { agentDefinition: { harness: 'codex', executionIdentity: localExecutionIdentity(workspaceId) } })
    probe.beforeToken = async () => {
      if (changed) Object.assign(probe.run, { agentDefinition: { harness: 'codex', executionIdentity: localExecutionIdentity('53100000-0000-4000-8000-000000000099') } })
    }
    const response = await claim(probe, [...preparedClaim, ...(changed ? [] : ['secret-snapshot'])])
    assert.equal(response.status, changed ? 409 : 200)
    const wire = await response.text()
    assert.equal(wire.includes(canary), false)
    assert.deepEqual(probe.membershipReads, [[changed ? '53100000-0000-4000-8000-000000000099' : workspaceId, ['member']]], 'real execution identity revalidation reaches the valid workspace before the secret fence')
    if (changed) assert.equal(wire.includes('mikka-egress-v1.'), false)
    else assert.equal(openEgressCapability(JSON.parse(wire).taskSecrets.grants[0].capability).workspaceId, workspaceId)
    assert.deepEqual(probe.secretReads.map(args => args[0]), [workspaceId])
  }
})

test('cloud protected grants preserve native subscription and GitHub credentials, and revoked membership fences all three', async t => {
  const keys = ['MIKKA_CLOUD_COMPUTER_TASKS', 'MIKKA_BYOS_ENABLED', 'MIKKA_BYO_E2B_KEY', 'WORKSPACE_SECRETS_KEY'] as const
  const saved = keys.map(key => process.env[key])
  Object.assign(process.env, { MIKKA_CLOUD_COMPUTER_TASKS: '1', MIKKA_BYOS_ENABLED: '1', MIKKA_BYO_E2B_KEY: '0', WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') })
  t.after(() => keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] }))
  for (const revoked of [false, true]) {
    const { probe, canary } = protectedFixture()
    probe.credentialCapability = true
    const nativeLease = { route: 'codex_cli', modelId: 'gpt-6-luna', revision: 1, accountId: 'fixture-account', accessToken: 'fixture-native-access', expiresAt: '2030-01-01T00:00:00.000Z' }
    Object.assign(probe, { nativeLease, caller: { userId: 'member', scopeDeviceId: 'device', scopeWorkspaceId: workspaceId },
      cloud: { subscription: { id: 'binding', consumerId: 'agent', workspaceId, route: 'codex_cli', modelId: 'gpt-6-luna' } } })
    Object.assign(probe.device, { kind: 'cloud', harnesses: [{ harness: 'codex', installed: true, toolApproval: true, subscriptionBroker: true }] })
    probe.beforeToken = async () => { if (revoked) probe.workspaceMemberAllowed = false }
    const response = await claim(probe, [...preparedCloudClaim, ...(revoked ? [] : ['secret-snapshot'])])
    assert.equal(response.status, revoked ? 409 : 200)
    const wire = await response.text(), body = JSON.parse(wire)
    assert.equal(wire.includes(canary), false)
    assert.deepEqual(probe.membershipReads, revoked ? [] : [[workspaceId, ['member']]])
    assert.deepEqual(probe.nativeLeaseCapabilities, [false])
    assert.deepEqual(probe.credentialOwners, ['member'])
    if (revoked) {
      for (const value of ['mikka-egress-v1.', nativeLease.accessToken, 'fixture-claim-github-token', probe.run.prompt]) assert.equal(wire.includes(value), false)
    } else {
      assert.deepEqual(body.subscriptionLease, nativeLease)
      assert.equal(body.github.token, 'fixture-claim-github-token')
      assert.equal(openEgressCapability(body.taskSecrets.grants[0].capability).workspaceId, workspaceId)
      assert.deepEqual(body.taskEnv, { TASK_REGION: 'fixture' })
    }
  }
})

test('selected Environments use sealed grants in both local and cloud claims without exposing protected values', async t => {
  const previousKey = process.env.WORKSPACE_SECRETS_KEY
  const previousCloud = process.env.MIKKA_CLOUD_COMPUTER_TASKS
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  process.env.MIKKA_CLOUD_COMPUTER_TASKS = '1'
  overrideDeploymentSwitch('byos', true)
  t.after(() => {
    if (previousKey === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = previousKey
    if (previousCloud === undefined) delete process.env.MIKKA_CLOUD_COMPUTER_TASKS; else process.env.MIKKA_CLOUD_COMPUTER_TASKS = previousCloud
    overrideDeploymentSwitch('byos', undefined)
  })
  for (const runtime of ['local', 'cloud'] as const) {
    const { probe, canary, secret } = protectedFixture()
    const { snapshot, definition } = selectEnvironment(probe, runtime)
    probe.environmentCapability = '1'
    probe.environmentInjection = { env: { TASK_MODE: 'fixture' }, secretNames: [], protectedSecrets: [secret], unavailable: [], snapshot: 'e'.repeat(64) }
    if (runtime === 'cloud') {
      definition.subscription = { bindingId: 'environment-binding', modelId: 'claude-haiku-5-5', route: 'claude_code_cli' }
      Object.assign(probe, { caller: { userId: 'member', scopeDeviceId: 'device', scopeWorkspaceId: workspaceId },
        cloud: { subscription: { id: definition.subscription.bindingId, consumerId: 'agent', workspaceId, modelId: definition.subscription.modelId, route: definition.subscription.route } } })
      Object.assign(probe.device, { kind: 'cloud', harnesses: [{ harness: 'claude_code', installed: true, toolApproval: true, subscriptionBroker: true }] })
    }
    const preparation = runtime === 'cloud' ? preparedCloudClaim : preparedClaim
    const response = await claim(probe, [...preparation.map(step => step === 'secrets' ? 'environment-secrets' : step), 'environment-snapshot'])
    assert.equal(response.status, 200, runtime)
    const wire = await response.text(), body = JSON.parse(wire)
    for (const value of [canary, Buffer.from(canary).toString('base64')]) assert.equal(wire.includes(value), false, runtime)
    assert.deepEqual(body.taskEnv, { TASK_MODE: 'fixture' })
    assert.equal(body.taskSecretNames, undefined)
    assert.deepEqual(body.projectEnvironment, { id: snapshot.environment!.id, revision: 7, setup: snapshot.environment!.setup })
    const opened = openEgressCapability(body.taskSecrets.grants[0].capability, { ownerId: probe.run.userId, workspaceId,
      repository: 'synthetic/claim-fixture', runId: probe.run.id, deviceId: probe.device.id, deviceTokenId: 'synthetic-device-token', attempt: 1 })
    assert.equal(opened.secret, canary)
    assert.equal(opened.secretId, secret.id)
    assert.deepEqual(probe.secretReads, [], 'an Environment never widens to the ordinary Workspace collection')
    assert.deepEqual(probe.secretSnapshotReads, [], 'the final fence uses the same selected collection')
    assert.equal(probe.environmentSnapshotReads.length, 1)
    assert.equal(typeof (probe.environmentSnapshotReads[0][4] as { select: unknown }).select, 'function')
  }
})

test('Environment support alone cannot downgrade a protected Secret to a plaintext assignment', async () => {
  for (const capability of [undefined, '2']) {
    const { probe, canary, secret } = protectedFixture()
    selectEnvironment(probe)
    probe.environmentCapability = '1'
    probe.secretCapability = capability
    probe.environmentInjection = { env: {}, secretNames: [], protectedSecrets: [secret], unavailable: [], snapshot: 'e'.repeat(64) }
    const response = await claim(probe, ['skill-preflight', 'policy', 'environment-secrets', 'daemon-upgrade'])
    assert.equal(response.status, 409)
    const wire = await response.text(), body = JSON.parse(wire)
    assert.equal(body.code, 'daemonUpgradeRequired')
    assert.equal(wire.includes(canary), false)
    assert.equal(body.taskEnv, undefined)
    assert.equal(body.taskSecrets, undefined)
    assert.equal(probe.run.leaseExpiresAt, null)
    assert.deepEqual(probe.secretReads, [])
    assert.deepEqual(probe.environmentSnapshotReads, [])
    assert.equal(probe.appCheckouts, 0)
  }
})

test('the final Environment fence refuses changed metadata, removed references and a changed configuration revision', async () => {
  for (const change of ['metadata', 'missing-reference', 'configuration-revision'] as const) {
    const { probe, canary, secret } = protectedFixture()
    const { definition } = selectEnvironment(probe)
    probe.environmentCapability = '1'
    probe.environmentInjection = { env: { TASK_MODE: 'fixture' }, secretNames: [], protectedSecrets: [secret], unavailable: [], snapshot: 'e'.repeat(64) }
    probe.beforeToken = async () => {
      if (change === 'metadata') probe.environmentSnapshot = 'f'.repeat(64)
      if (change === 'missing-reference') probe.environmentSnapshotError = new CodedError('task_secret_unavailable', { detail: 'configuration' })
      if (change === 'configuration-revision') definition.projectExecution.environment!.revision++
    }
    const response = await claim(probe, [...preparedClaim.map(step => step === 'secrets' ? 'environment-secrets' : step),
      ...(change === 'configuration-revision' ? [] : ['environment-snapshot'])])
    assert.equal(response.status, 409, change)
    const wire = await response.text()
    for (const value of [canary, 'mikka-egress-v1.', probe.run.prompt, 'TASK_MODE']) assert.equal(wire.includes(value), false, change)
    assert.deepEqual(probe.secretReads, [])
    assert.equal(probe.environmentSnapshotReads.length, change === 'configuration-revision' ? 0 : 1)
  }
})

test('persisted Task and Run ownership reject missing or conflicting scope before any claim preparation', async () => {
  for (const mismatch of ['pending-task', 'missing-run-workspace', 'foreign-task-workspace', 'frozen-null', 'frozen-workspace', 'claim-workspace'] as const) {
    const probe = fixture()
    if (mismatch === 'pending-task') probe.issue.ownershipState = 'pending'
    if (mismatch === 'missing-run-workspace') Object.assign(probe.run, { workspaceId: null })
    if (mismatch === 'foreign-task-workspace') probe.issue.workspaceId = '53100000-0000-4000-8000-000000000003'
    if (mismatch === 'frozen-null' || mismatch === 'frozen-workspace') Object.assign(probe.run, {
      agentDefinition: { harness: 'codex', executionIdentity: localExecutionIdentity(mismatch === 'frozen-null' ? null : 'other-workspace') },
    })
    if (mismatch === 'claim-workspace') Object.assign(probe, { caller: { userId: 'member', scopeWorkspaceId: 'other-workspace' } })
    const response = await claim(probe, [], mismatch !== 'missing-run-workspace')
    assert.equal(response.status, 409, mismatch)
    assert.deepEqual(await response.json(), { error: 'Run ownership unavailable.' }, mismatch)
    assert.equal(probe.run.status, 'queued', mismatch)
    assert.equal(probe.run.leaseExpiresAt, null, mismatch)
    assert.deepEqual(probe.secretReads, [], mismatch)
    assert.deepEqual(probe.secretSnapshotReads, [], mismatch)
    assert.deepEqual(probe.credentialOwners, [], mismatch)
    assert.deepEqual(probe.nativeLeaseCapabilities, [], mismatch)
    assert.equal(probe.appCheckouts, 0, mismatch)
  }
})

test('removing a frozen identity cannot release a grant prepared under its workspace authority', async t => {
  const saved = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  t.after(() => { if (saved === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = saved })
  const { probe, canary } = protectedFixture()
  probe.credentialCapability = true
  Object.assign(probe.run, { agentDefinition: { harness: 'codex', executionIdentity: localExecutionIdentity(workspaceId) } })
  probe.beforeToken = async () => { Object.assign(probe.run, { agentDefinition: { harness: 'codex' } }) }
  const response = await claim(probe, preparedClaim)
  assert.equal(response.status, 409)
  const wire = await response.text()
  for (const value of [canary, 'mikka-egress-v1.', 'fixture-claim-github-token', probe.run.prompt]) assert.equal(wire.includes(value), false)
  assert.deepEqual(probe.secretSnapshotReads, [])
  assert.deepEqual(probe.membershipReads, [])
  assert.deepEqual(probe.locks, ['workspaces', 'workspace_members', 'issues', 'agent_runs'])
})
