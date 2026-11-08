import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { gzipSync } from 'node:zlib'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { REPO_ORIGIN_HEADER, PROJECT_ENVIRONMENT_HEADER, RECOVERY_WORKTREE_HEADER, RUN_CREDENTIALS_HEADER, type RunCheckpoint } from '@mikka/protocol/device'
import { SUBSCRIPTION_MODEL_CATALOGUE_HEADER } from '@mikka/protocol/subscription'
import { normalizeRepository } from '@mikka/protocol/repository'
import { SKILL_ARTIFACT_HEADER } from '@mikka/protocol/skill'
import { POLICY_SNAPSHOT_HEADER } from '@mikka/protocol/policy-snapshot'
import { policyDistributionContext } from '../lib/agent-tool-approval/policy-distribution'
import { verifyPolicySnapshot } from '@mikka/protocol/node-policy-snapshot'
import { POST } from '../app/v1/devices/[deviceId]/runs/[runId]/claim/route'
import { overrideDeploymentSwitch } from '../lib/deployment-switches'
import { AgentProfileAdmissionError } from '../lib/factory/profile-admission'
import { AgentProfileError } from '../lib/factory/agent-profile-definition'
import type { ProjectExecutionSnapshot } from '../lib/project-resources/contracts'
import type { ProjectExecutionInput } from '../lib/project-resources/store'

const workspaceId = '53100000-0000-4000-8000-000000000002'
function fixture() {
  const repository = normalizeRepository('https://github.com/synthetic/claim-fixture.git')
  const probe = {
    workspace: { id: workspaceId, kind: 'team', ownerId: 'owner' },
    run: { id:'run',userId:'member',workspaceId,issueId:'issue',agentId:'agent',deviceId:'device',deviceRepoId:'repo',baseBranch:null as string|null,status:'queued',prompt:'private claim instructions',kind:'implement',retryOf:null as string|null,stopReason:null as string|null,stopRequestedAt:null as Date|null,leaseExpiresAt:null as Date|null },
    issue: {id:'issue',userId:'owner',workspaceId,ownershipState:'bound',scope:'workspace',linearSyncPolicy:'explicit',linearSyncBlocked:false,content:{type:'doc'}},
    device: {id:'device',ownerId:'member',enabled:true,kind:'local',protocolVersion:DAEMON_PROTOCOL_VERSION,harnesses:[{harness:'codex',installed:true,toolApproval:true}]},
    agent: {id:'agent',userId:'member',deviceId:'device',harness:'codex'},
    repo: {id:'repo',userId:'member',deviceId:'device',baseBranch:'main',repoPath:repository.key,remoteUrl:repository.remoteUrl},
    // The CLI layer as resolveTrustedRunPolicy builds it: an unset git_push does not restrict the App grant.
    cliPolicy: {revision:'a'.repeat(64),policy:{...defaultRunPolicy(),permissions:{...defaultRunPolicy().permissions,git_push:'allow' as const}},workspaceIds:[] as string[],workspaceId:null,hierarchy:undefined,policySnapshotRequired:false,layers:{agent:{},worker:{},workspace:{}}},
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
    secretReads: [] as unknown[][],
    environmentInjection: undefined as { env: Record<string, string>; secretNames: string[] } | undefined,
    environmentReads: [] as { workspaceId: string; repository: string | null; configuration: NonNullable<ProjectExecutionSnapshot['environment']>; ownerId: string }[],
    projectAdmission: { decision: 'allow' as 'allow' | 'projectRepositoryDenied' | 'projectEnvironmentUnavailable',
      calls: [] as { input: ProjectExecutionInput; frozen: ProjectExecutionSnapshot | undefined }[], active: false, operations: 0, releases: 0 },
  }
  Object.assign(globalThis,{claimResponseProbe:probe})
  return probe
}
async function claim(probe: ReturnType<typeof fixture>, preparation = ['skill-preflight','policy','publication','claim','skill-claim','benchmark-claim','token','settings'], expectsProjectAdmission = true) {
  const diagnostics: unknown[][] = []
  const errors = mock.method(console, 'error', (...args: unknown[]) => { diagnostics.push(args) })
  try { return await POST(new Request('http://127.0.0.1/mikka/v1/devices/device/runs/run/claim',{method:'POST',headers:{[REPO_ORIGIN_HEADER]:'1',[SKILL_ARTIFACT_HEADER]:'1',...(probe.strictRecovery ? {[RECOVERY_WORKTREE_HEADER]:'1'} : {}),...(probe.policyCapability?{[POLICY_SNAPSHOT_HEADER]:probe.policyCapability}:{}),...(probe.credentialCapability ? {[RUN_CREDENTIALS_HEADER]:'1'} : {}),...(probe.catalogueCapability ? {[SUBSCRIPTION_MODEL_CATALOGUE_HEADER]:'1'} : {}),...(probe.environmentCapability ? {[PROJECT_ENVIRONMENT_HEADER]:probe.environmentCapability} : {})}}),{params:Promise.resolve({deviceId:'device',runId:'run'})}) }
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
  probe.environmentInjection = { env: { TASK_MODE: 'fixture', SELECTED_SECRET: 'synthetic-selected-environment-value' }, secretNames: ['SELECTED_SECRET'] }
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
        ? ['skill-preflight', 'policy', 'model-admission', 'environment-secrets', 'claim', 'skill-claim', 'benchmark-claim', 'token', 'settings']
        : ['skill-preflight', 'policy', 'environment-secrets', 'publication', 'claim', 'skill-claim', 'benchmark-claim', 'token', 'settings'])
      assert.equal(response.status, 200, runtime)
      const body = await response.json()
      assert.equal(body.baseBranch, 'release/frozen-environment')
      assert.equal(body.harness, 'claude_code', 'the frozen harness takes precedence over the current Agent')
      assert.deepEqual(body.projectEnvironment, { id: snapshot.environment!.id, revision: 7, setup: snapshot.environment!.setup })
      assert.deepEqual(body.taskEnv, probe.environmentInjection!.env)
      assert.deepEqual(body.taskSecretNames, ['SELECTED_SECRET'])
      assert.deepEqual(probe.environmentReads, [{ workspaceId, repository: probe.repo.remoteUrl, configuration: snapshot.environment, ownerId: probe.run.userId }])
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
  const response=await claim(probe,['question-retry','checkpoint','skill-preflight','policy','publication','claim','skill-claim','benchmark-claim','token','settings'])
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
    const response = await claim(probe, variant === 'readOnly' ? ['skill-preflight','policy','claim','skill-claim','benchmark-claim','token','settings'] : undefined)
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
    assert.equal(body.github.endpoint, 'http://127.0.0.1/api/runs/github-token')
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
    const response=await claim(probe,['question-retry','checkpoint','skill-preflight','policy','publication','claim','skill-claim','benchmark-claim','token','settings'])
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
    const response=await claim(probe,['question-retry','checkpoint','skill-preflight','policy','publication','claim','skill-claim','benchmark-claim','token','settings'])
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
    const response=await claim(probe,['question-retry','checkpoint','skill-preflight','policy','publication','claim','skill-claim','benchmark-claim','token','settings'])
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
      assert.deepEqual((probe as typeof probe & {secretReads:unknown[][]}).secretReads.map(args=>[args[0],args[1],args[4]]),[[workspaceId,probe.repo.remoteUrl,probe.run.userId]])
    }
    for(const denial of ['authentication','device-scope','workspace-scope'] as const) {
      const probe=fixture()
      Object.assign(probe,{caller:denial==='authentication' ? null : {userId:'member',scopeDeviceId:denial==='device-scope' ? 'foreign-device' : 'device',scopeWorkspaceId:'foreign-workspace'},cloud:{subscription:{id:'binding',consumerId:'agent',workspaceId,route:'codex_cli',modelId:'fixture-subscription-model'}},secretInjection:{env:{TASK_SECRET:'must-not-leave'},secretNames:['TASK_SECRET']}})
      Object.assign(probe.device,{kind:'cloud',harnesses:[{harness:'codex',installed:true,toolApproval:true,computerBroker:true,subscriptionBroker:true}]})
      const response=await claim(probe,denial==='workspace-scope' ? ['skill-preflight','policy'] : [],denial==='workspace-scope')
      assert.equal(response.status,denial==='authentication' ? 401 : denial==='device-scope' ? 404 : 409)
      assert.equal((await response.text()).includes('must-not-leave'),false)
      assert.ok(!probe.preparation.includes('secrets'))
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
      const preparation = ['skill-preflight','policy','model-admission','publication','claim','skill-claim','benchmark-claim','token','settings']
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
    const response = await claim(probe, ['skill-preflight', 'policy', 'publication', 'claim-rejected'])
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
