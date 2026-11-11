// In-memory claim boundary tests. No sockets, providers or database connections.
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core'

const expectedMembershipSql = "select \"mikka_workspaces\".\"id\", \"mikka_workspaces\".\"kind\", \"mikka_organization_workspaces\".\"organizationId\" from \"mikka_workspaces\" inner join \"mikka_workspace_members\" on \"mikka_workspace_members\".\"workspaceId\" = \"mikka_workspaces\".\"id\" left join \"mikka_organization_workspaces\" on \"mikka_organization_workspaces\".\"workspaceId\" = \"mikka_workspaces\".\"id\" where (\"mikka_workspace_members\".\"userId\" = $1 and \"mikka_workspace_members\".\"status\" = $2 and \"mikka_workspaces\".\"id\" = $3 and (\"mikka_workspaces\".\"kind\" = $4 or (\"mikka_workspaces\".\"kind\" = $5 and \"mikka_workspaces\".\"userId\" = $6))) order by \"mikka_workspaces\".\"createdAt\" asc"
function expandMembershipAliases(sql) {
  for (const [table, name] of [['mikka_workspaces', 'w'], ['mikka_workspace_members', 'm'], ['mikka_organization_workspaces', 'o']]) {
    sql = sql.replaceAll('"' + table + '" "' + name + '"', '"' + table + '"')
      .replaceAll('"' + name + '".', '"' + table + '".')
  }
  return sql
}
const dialect = new PgDialect()
function workspaceQuery(columns) {
  let table, condition, organizationJoin = false, statement = new QueryBuilder().select(columns)
  const organizations = () => {
    const p = globalThis.claimResponseProbe
    assert.equal(table, 'mikka_organization_workspaces')
    assert.deepEqual(condition.params, [p.workspace.id])
    assert.ok(condition.sql === '"mikka_organization_workspaces"."workspaceId" = $1'
      || condition.sql === '"mikka_organization_workspaces"."workspaceId" in ($1)')
    if (columns !== undefined) assert.deepEqual(Object.keys(columns), ['organizationId'])
    // This claim-composition fixture has no Organization-link row. The real
    // Enterprise gate consumes that exact projection; unknown queries fail.
    return []
  }
  const query = {
    from(value) { table = value[Object.getOwnPropertySymbols(value).find(s => s.description === 'drizzle:Name')]; statement = statement.from(value); return query },
    innerJoin(value, predicate) { statement = statement.innerJoin(value, predicate); return query },
    leftJoin(value, predicate) {
      const join = dialect.sqlToQuery(predicate)
      assert.deepEqual(join.params, [])
      if (table === 'mikka_workspace_members') {
        assert.equal(value[Object.getOwnPropertySymbols(value).find(s => s.description === 'drizzle:Name')], 'mikka_organization_workspaces')
        assert.equal(join.sql, '"mikka_organization_workspaces"."workspaceId" = "mikka_workspace_members"."workspaceId"')
        assert.deepEqual(Object.keys(columns), ['id', 'organizationId'])
      } else {
        // The unlocked membership path is checked as a complete real query
        // at orderBy, including its original base tables and all predicates.
        assert.deepEqual(Object.keys(columns), ['id', 'kind', 'organizationId'])
      }
      statement = statement.leftJoin(value, predicate)
      organizationJoin = true
      return query
    },
    where(value) { condition = dialect.sqlToQuery(value); statement = statement.where(value); return query },
    async for(mode, options) {
      const p = globalThis.claimResponseProbe
      assert.equal(mode, 'share')
      if (table === 'mikka_workspaces') {
        assert.deepEqual(condition.params, [p.workspace.id])
        p.locks.push('workspaces')
        return [p.workspace]
      }
      assert.equal(table, 'mikka_workspace_members')
      assert.equal(organizationJoin, true)
      assert.ok(options?.of)
      assert.equal(options.of[Object.getOwnPropertySymbols(options.of).find(s => s.description === 'drizzle:Name')], 'mikka_workspace_members')
      assert.deepEqual(condition.params, [p.workspace.id, p.run.userId, 'active'])
      p.locks.push('workspace_members')
      return p.memberAllowed && p.workspaceMemberAllowed ? [{ id: p.run.userId, organizationId: null }] : []
    },
    async limit(value) { assert.equal(value, 1); return organizations() },
    // oxlint-disable-next-line unicorn/no-thenable -- Match the awaited Org-link SELECT.
    then(resolve, reject) { return Promise.resolve().then(organizations).then(resolve, reject) },
    async orderBy(order) {
      const p = globalThis.claimResponseProbe
      assert.equal(organizationJoin, true)
      assert.deepEqual(Object.keys(columns), ['id', 'kind', 'organizationId'])
      const compiled = statement.orderBy(order).toSQL()
      assert.equal(expandMembershipAliases(compiled.sql), expectedMembershipSql)
      assert.deepEqual(compiled.params, [p.run.userId, 'active', p.workspace.id, 'team', 'personal', p.run.userId])
      return p.memberAllowed && p.workspaceMemberAllowed ? [{ ...p.workspace, organizationId: null }] : []
    },
  }
  return query
}
// Keep withRunWorkspace, mayCompleteIssue and their lock order real. Only the
// workspace database transport is modeled alongside the App transaction below.
export const claimWorkspaceDatabase = { select: workspaceQuery, transaction: callback => callback({ select: workspaceQuery }) }
export const claimWorkspacePool = { async query(sql, args) {
  const p = globalThis.claimResponseProbe
  assert.equal(sql.replace(/\s+/g, ' ').trim(), 'SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status=\'active\'')
  assert.deepEqual(args[1], [p.run.userId])
  p.membershipReads.push(args)
  return { rows: p.workspaceMemberAllowed ? args[1].map(userId => ({ userId })) : [] }
} }
const nextServer = import.meta.resolve('next/server')
const modelContract = new URL('../../lib/model-admission/contract.ts', import.meta.url).href
const actionError = new URL('../../lib/action-error.ts', import.meta.url).href
const mailboxCapability = new URL('../../lib/personal-mailbox-capability.ts', import.meta.url).href
const repositoryContract = import.meta.resolve('@mikka/protocol/repository')
const projectExecutionSource = `
import assert from 'node:assert/strict'
import {ActionFailureError} from ${JSON.stringify(actionError)}
export async function withRunProjectExecution(input,frozen,operation){
  const p=globalThis.claimResponseProbe, lease=p.projectAdmission
  assert.ok(lease,'project admission must be explicitly configured')
  assert.equal(lease.calls.length,0,'one resource admission per claim')
  assert.deepEqual(input,{userId:p.run.userId,workspaceId:p.run.workspaceId,issueId:p.run.issueId,
    repositoryKey:p.repo.remoteUrl?p.repo.repoPath:null,baseBranch:p.run.baseBranch,
    runtime:p.device.kind==='cloud'?'cloud':'local',harness:p.run.agentDefinition?.harness??p.agent.harness})
  assert.deepEqual(frozen,p.run.agentDefinition?.projectExecution,'validate the stored execution snapshot')
  assert.equal(typeof operation,'function')
  if(!['allow','projectRepositoryDenied','projectEnvironmentUnavailable'].includes(lease.decision))throw new Error('unexpected project admission decision')
  lease.calls.push({input:structuredClone(input),frozen:structuredClone(frozen)})
  lease.active=true
  try{
    if(lease.decision!=='allow')throw new ActionFailureError(lease.decision)
    lease.operations++
    return await operation()
  }finally{lease.active=false;lease.releases++}
}
`
const secretSource = `
import assert from 'node:assert/strict'
import {normalizeRepository} from ${JSON.stringify(repositoryContract)}
export function remoteRepositoryRef(url){if(!url)return null;const repo=normalizeRepository(url);const prefix="v2/github.com/";return repo.key.startsWith(prefix)?repo.key.slice(prefix.length):null}
export async function taskSecretInjection(...args){
  const p=globalThis.claimResponseProbe
  assert.equal(args.length,5)
  assert.equal(args[0],p.run.workspaceId);assert.equal(args[1],remoteRepositoryRef(p.repo.remoteUrl))
  assert.ok(args[2]===process.env,'ordinary task secrets use the process environment')
  assert.equal(args[3],undefined);assert.equal(args[4],p.run.userId)
  assert.equal(p.projectAdmission.active,true,'secret preparation requires the live resource lease')
  assert.equal(p.run.agentDefinition?.projectExecution?.environment??null,null,'selected environments cannot fall back to all workspace secrets')
  p.preparation.push('secrets');(p.secretReads??=[]).push(args)
  return structuredClone({env:{},secretNames:[],protectedSecrets:[],unavailable:[],...p.secretInjection})
}
export async function taskSecretSnapshot(...args){
  const p=globalThis.claimResponseProbe
  assert.equal(args[2],p.run.userId);assert.equal(typeof args[3].select,'function')
  assert.equal(p.appActive,1,'snapshot shares the final APP transaction')
  p.preparation.push('secret-snapshot');p.secretSnapshotReads.push(args)
  return p.secretSnapshot??p.secretInjection?.snapshot
}
export async function environmentSecretInjection(...args){
  const p=globalThis.claimResponseProbe,configuration=p.run.agentDefinition?.projectExecution?.environment
  assert.ok(configuration,'environment injection requires a frozen selection')
  assert.equal(args.length,5)
  assert.equal(args[0],p.run.workspaceId);assert.equal(args[1],remoteRepositoryRef(p.repo.remoteUrl))
  assert.deepEqual(args[2],configuration)
  assert.ok(args[3]===process.env,'environment secrets use the process environment')
  assert.equal(args[4],p.run.userId)
  assert.equal(p.projectAdmission.active,true,'environment preparation requires the live resource lease')
  assert.ok(p.environmentInjection,'environment secret outcome must be explicitly configured')
  p.preparation.push('environment-secrets')
  p.environmentReads.push({workspaceId:args[0],repository:args[1],configuration:structuredClone(args[2]),ownerId:args[4]})
  return structuredClone(p.environmentInjection)
}
export async function environmentSecretSnapshot(...args){
  const p=globalThis.claimResponseProbe
  assert.equal(args.length,5)
  assert.equal(args[0],p.run.workspaceId);assert.equal(args[1],remoteRepositoryRef(p.repo.remoteUrl))
  assert.deepEqual(args[2],p.run.agentDefinition.projectExecution.environment)
  assert.equal(args[3],p.run.userId);assert.equal(typeof args[4].select,'function')
  assert.equal(p.appActive,1);assert.equal(p.projectAdmission.active,true)
  p.preparation.push('environment-snapshot');p.environmentSnapshotReads.push(args)
  if(p.environmentSnapshotError)throw p.environmentSnapshotError
  return p.environmentSnapshot??p.environmentInjection.snapshot
}
`
const dbSource = `import assert from 'node:assert/strict'
import {PgDialect} from ${JSON.stringify(import.meta.resolve('drizzle-orm/pg-core'))}

function query(columns){
  let table
  const q={from(value){table=value[Object.getOwnPropertySymbols(value).find(s=>s.description==='drizzle:Name')];return q},innerJoin(){return q},where(){return q},
    async limit(){const p=globalThis.claimResponseProbe;assert.ok(['agent_runs','agents','device_repos'].includes(table),'unexpected claim table');return table==='agent_runs'?[(columns?.sessionId&&p.lost)?p.lost:structuredClone(p.run)]:table==='agents'?[p.agent]:[p.repo]},
    async for(){const p=globalThis.claimResponseProbe;assert.ok(['issues','agent_runs'].includes(table),'unexpected locked claim table');p.locks.push(table);return table==='issues'?[p.issue]:[{run:structuredClone(p.run),enabled:true}]}}
  return q
}
function update(value){
  const table=value[Object.getOwnPropertySymbols(value).find(s=>s.description==='drizzle:Name')]
  return {set(values){return {where(condition){
    const execute=async()=>{
      const p=globalThis.claimResponseProbe;(p.updates??=[]).push({table,values:{...values}})
      await p.beforeUpdate?.(table,values)
      // Evaluate the route's actual equality and NULL predicates; unsupported
      // expressions must not turn a rejected CAS into a fixture success.
      const rendered=new PgDialect().sqlToQuery(condition)
      const terms=[...rendered.sql.matchAll(/"agent_runs"\\."(\\w+)" = \\$(\\d+)/g)]
      const nulls=[...rendered.sql.matchAll(/"agent_runs"\\."(\\w+)" is null/g)]
      if(rendered.sql.replace(/"agent_runs"\\."\\w+" = \\$\\d+|"agent_runs"\\."\\w+" is null|[() ]|and/g,'')!=='')throw new Error('unsupported claim WHERE: '+rendered.sql)
      const same=(a,b)=>a instanceof Date||b instanceof Date?a!=null&&b!=null&&new Date(a).getTime()===new Date(b).getTime():a===b
      const changed=table==='agent_runs'&&terms.every(([,column,index])=>same(p.run[column],rendered.params[Number(index)-1]))&&nulls.every(([,column])=>p.run[column]==null)
      if(changed)Object.assign(p.run,values)
      return changed?[{id:p.run.id}]:[]
    }
    let result
    const once=()=>result??=execute()
    return {then(resolve,reject){return once().then(()=>undefined).then(resolve,reject)},returning(){return once()}}
  }}}}
}
let checkedOutClient
export const db={select:query,update,transaction:async fn=>{const p=globalThis.claimResponseProbe;assert.equal(p.appActive,1,'claim transaction uses the checked-out APP client');p.transactions++;const error=p.transactionErrors.shift();if(error)throw error;return fn({select:query})}}
export const pool={async query(sql,args){
  const p=globalThis.claimResponseProbe
  assert.equal(p.appActive,1,'execution identity remains inside the checked-out APP transaction')
  assert.equal(sql,'SELECT "ownerId",kind,enabled FROM devices WHERE id=$1')
  assert.deepEqual(args,[p.device.id]);return {rows:[p.device]}
},connect:async()=>{
  const p=globalThis.claimResponseProbe
  assert.equal(checkedOutClient,undefined,'claim cannot acquire a second APP client')
  assert.equal(p.appActive,0)
  assert.equal(p.projectAdmission.active,true,'resource lease survives through the final response fence')
  assert.equal(p.locks.at(-1),'workspace_members','Workspace admission precedes APP checkout')
  p.appActive=1;p.appCheckouts++
  const client={release(){
    assert.equal(checkedOutClient,client,'release the exact owning APP client')
    assert.equal(p.appActive,1)
    checkedOutClient=undefined;p.appActive=0;p.appReleases++
  }}
  checkedOutClient=client
  return client
}}
export async function withDatabaseClient(client,operation){
  assert.equal(client,checkedOutClient,'bind the exact checked-out APP client')
  return operation()
}
`
const sources = new Map([
  ['/lib/device-route.ts', 'export const withDeviceRoute=handler=>handler'],
  ['/lib/project-resources/run-lease.ts', projectExecutionSource],
  ['/lib/model-admission/runtime.ts', `import {ModelAdmissionError} from ${JSON.stringify(modelContract)};export async function assertUnmanagedModelTransport(scope,model){const p=globalThis.claimResponseProbe;p.preparation.push('model-admission');(p.modelAdmissionScopes??=[]).push(scope);(p.modelAdmissionCalls??=[]).push({scope,model});if(p.modelAdmissionDeniedWorkspace===scope.workspaceId)throw new ModelAdmissionError('modelRouteDenied')};export async function assertSubscriptionModelTransport(scope,model,route){const p=globalThis.claimResponseProbe;(p.subscriptionAdmissionCalls??=[]).push({scope,model,route});await assertUnmanagedModelTransport(scope,model)}`],
  ['/lib/db/index.ts', dbSource],
  ['/lib/workspace-db.ts', `export {claimWorkspaceDatabase as workspaceDb, claimWorkspacePool as workspacePool} from ${JSON.stringify(import.meta.url)}`],
  ['/lib/device-link.ts', 'export async function authenticateDevice(){const p=globalThis.claimResponseProbe;return Object.hasOwn(p,"caller") ? (p.caller && {tokenId:"synthetic-device-token",...p.caller}) : {userId:"member",tokenId:"synthetic-device-token"}};export async function ownedDevice(){return globalThis.claimResponseProbe.device};export async function ownedDeviceWithReport(){return globalThis.claimResponseProbe.device}'],
  ['/lib/device-repositories.ts', 'export async function readRepositorySettings(...args){const p=globalThis.claimResponseProbe;p.preparation.push("settings");(p.settingsReads??=[]).push(args);return p.repositorySettings??null}'],
  ['/lib/agent-tool-approval/policy-store.ts', 'export async function readCliRunPolicy(){const p=globalThis.claimResponseProbe;p.preparation.push("policy");return structuredClone(p.cliPolicy)}'],
  ['/lib/self-improvement/server.ts', 'export const skillAssignments={async preflight(){globalThis.claimResponseProbe.preparation.push("skill-preflight")},async recordClaim(){globalThis.claimResponseProbe.preparation.push("skill-claim")}};export async function claimBenchmarkAssignment(){globalThis.claimResponseProbe.preparation.push("benchmark-claim")}'],
  ['/lib/factory/runtime.ts', 'export async function guardFactoryClaim(){return {}}'],
  ['/lib/factory/questions/retry.ts', 'export async function blockQuestionRetry(){const p=globalThis.claimResponseProbe;p.preparation.push("question-retry");if(p.questionRetryBlocked){p.run.status="failed";p.run.stopReason="blocked"};return p.questionRetryBlocked}'],
  ['/lib/run-publications.ts', 'export async function prepareRunPublication(){const p=globalThis.claimResponseProbe;p.preparation.push("publication");return structuredClone(p.publication)};export async function persistRunCompletion(_owner,_run,completion){const p=globalThis.claimResponseProbe;if(completion.stopReason==="error"&&completion.report.summary==="The task is no longer available to this thread."){p.preparation.push("issue-unavailable");return}if(!p.run.retryOf||completion.stopReason!=="blocked")throw new Error("unexpected publication failure");p.preparation.push("blocked-recovery");p.run.status="stopped";p.run.stopReason="blocked"}'],
  ['/lib/issue-team-access.ts', 'export async function issueTeamAccess(){return {allowed:globalThis.claimResponseProbe.memberAllowed}}'],
  ['/lib/issue-access.ts', 'export async function issueForUser(){const p=globalThis.claimResponseProbe;if(p.issueAccessError)throw p.issueAccessError;return p.memberAllowed&&!p.issue?.content?.attrs?.mikka?.deletedAt?p.issue:null}'],
  ['/lib/mcp/worker.ts', 'export async function issueRunToken(){const p=globalThis.claimResponseProbe;p.preparation.push("token");await p.beforeToken?.();if(p.tokenError)throw new Error("synthetic token refusal");return {token:"synthetic-only"}}'],
  // These claims have no frozen mailbox grant. Validate that fact through the
  // real capability contract instead of accidentally failing its module load.
  ['/lib/personal-mailbox-runtime.ts', `import assert from 'node:assert/strict'
    import {personalWorkerMailboxScopeMatches} from ${JSON.stringify(mailboxCapability)}
    export async function personalWorkerMailboxAdvertised(owner,runId){
      const p=globalThis.claimResponseProbe
      assert.deepEqual([owner,runId],[p.run.userId,p.run.id])
      assert.equal(p.projectAdmission.active,true)
      assert.equal(personalWorkerMailboxScopeMatches(p.run.agentDefinition?.harness??p.agent.harness,p.run.agentDefinition,{botId:p.run.botId??null,workspaceId:p.run.workspaceId}),false)
      p.mailboxLookups.push([owner,runId]);return []
    }`],
  ['/lib/computer/claim.ts', `
    function claimTransaction(){
      const p=globalThis.claimResponseProbe
      return {query(sql,args){
        if(!sql.startsWith('UPDATE agent_runs SET "deviceTokenId"=$2')||args[0]!==p.run.id||args[1]!=="synthetic-device-token"||args[2]!=="member")throw new Error("unexpected SQL in claim fixture")
        p.run.deviceTokenId=args[1]
        p.run.machineAuthority=args[3]
        return Promise.resolve({rows:[],rowCount:1})
      }}
    }
    export async function claimLocalRun(_pool,_run,_device,lease,_binding,beforeClaim,afterClaim){
      const p=globalThis.claimResponseProbe;const tx=claimTransaction()
      if(typeof beforeClaim!=="function"||typeof afterClaim!=="function")throw new Error("claim callbacks missing")
      if(await beforeClaim(tx)===false)return "unavailable"
      if(p.claimError){p.preparation.push("claim-rejected");throw p.claimError}
      p.preparation.push("claim");p.run.status="preparing";p.run.leaseExpiresAt=lease
      await afterClaim(tx);return "claimed"
    }
    export async function claimCloudRun(_pool,_actor,_run,_device,lease,_binding,beforeClaim,afterClaim){
      const p=globalThis.claimResponseProbe;const tx=claimTransaction()
      if(!p.cloud)throw new Error("unexpected cloud claim")
      if(await beforeClaim(tx)===false)return null
      if(p.claimError){p.preparation.push("claim-rejected");throw p.claimError}
      p.preparation.push("claim");p.run.status="preparing";p.run.leaseExpiresAt=lease
      await afterClaim(tx);return {botId:"bot",ownerId:"member",display:":1",policyVersion:1,permission:"ask"}
    }
  `],
  // Retain the actual nativeRunBinding checks, including consumer/harness and
  // requested Workspace. Only its metadata repository is synthetic.
  ['/lib/subscription-repository.ts', `import assert from 'node:assert/strict'
    export class SubscriptionRepository {
      constructor(query){assert.equal(typeof query.query,'function')}
      async nativeBinding(owner,agent,harness,bindingId,workspaceId,options){
        const p=globalThis.claimResponseProbe
        assert.deepEqual([owner,agent,harness],[p.run.userId,p.agent.id,p.run.agentDefinition?.harness??p.agent.harness])
        assert.deepEqual(options,{currentConnection:true})
        assert.equal(p.projectAdmission.active,true)
        assert.ok(p.cloud?.subscription,'subscription metadata must be explicitly configured')
        const binding=p.cloud.subscription
        return bindingId&&bindingId!==binding.id?null:structuredClone(binding)
      }
    }`],
  ['/lib/secrets/runtime.ts', secretSource],
  ['/lib/run-completion-effects.ts', 'export async function afterRunEnded(ownerId,runId){const p=globalThis.claimResponseProbe;(p.endedRuns??=[]).push({ownerId,runId})}'],
  ['/lib/run-leases.ts', 'export async function latestCheckpoint(){const p=globalThis.claimResponseProbe;p.preparation.push("checkpoint");return structuredClone(p.checkpoint)};export async function failRunForDaemonUpgrade(...args){const p=globalThis.claimResponseProbe;p.preparation.push("daemon-upgrade");(p.upgradeRefusals??=[]).push(args);p.run.status="failed";p.run.stopReason="error";return true};export async function failQueuedSubscriptionRuntime(...args){const p=globalThis.claimResponseProbe;p.preparation.push("subscription-preflight");p.runtimeRefusal=args;p.run.status="failed";return true}'],
  ['/lib/daemon-release.ts', 'export function daemonTooOld(){return false};export async function daemonVersions(){return {min:"0.0.1",latest:"0.0.1"}}'],
  ['/lib/app-tools-server.ts', `import assert from 'node:assert/strict'
    export async function runAppToolkits(owner,botId){
      const p=globalThis.claimResponseProbe
      assert.deepEqual([owner,botId],[p.run.userId,p.run.botId??null])
      assert.equal(p.projectAdmission.active,true)
      assert.deepEqual(p.appToolkits,[],'connected apps must be explicitly configured')
      p.appToolkitLookups.push([owner,botId]);return []
    }`],
  ['/lib/github/repository-installation.ts', 'export async function linkedGitHubAccountId(userId){const p=globalThis.claimResponseProbe;(p.githubLookups??=[]).push(userId);return p.githubAccountId===undefined?"123":p.githubAccountId}'],
  // Exercise the real machine-credential selector. These OAuth fixtures have
  // no self-hosted Cloud capability; unknown configuration is never guessed.
  ['/lib/github/cloud.ts', `import assert from 'node:assert/strict'
    function scope(owner){const p=globalThis.claimResponseProbe;assert.equal(owner,p.run.userId);assert.equal(p.projectAdmission.active,true);assert.equal(p.cloudGitHubConfigured,false);return p}
    export async function useCloudGitHub(owner){const p=scope(owner);p.cloudGitHubLookups.push(owner);return false}
    export async function cloudGitHubCredential(owner,remoteKey){const p=scope(owner);assert.equal(remoteKey,p.repo.repoPath);p.cloudGitHubCredentials.push([owner,remoteKey]);return null}
  `],
  ['/lib/github/user-access.ts', 'export async function githubTokenForUser(owner){const p=globalThis.claimResponseProbe;p.credentialOwners.push(owner);await p.beforeCredential?.();if(p.credentialFailure)throw p.credentialFailure;return {token:"fixture-claim-github-token",githubAccountId:"123",expiresAt:new Date("2030-01-01T00:00:00.000Z")}}'],
  ['/lib/subscription-runtime.ts', `import assert from 'node:assert/strict'
    export function subscriptionRuntime(...args){
      const p=globalThis.claimResponseProbe
      assert.equal(p.projectAdmission.active,true)
      if(args.length)assert.deepEqual(args,[true,false,{exportAccessLease:true}])
      return {
        repository:{async nativeBinding(owner,agent,harness){
          assert.deepEqual([owner,agent,harness],[p.run.userId,p.agent.id,p.agent.harness])
          assert.equal(p.device.kind,'local');assert.equal(p.run.agentDefinition??null,null)
          assert.equal(p.ownNativeBinding,null,'legacy fixture explicitly has no subscription binding')
          p.localBindingLookups.push([owner,agent,harness]);return null
        }},
        async nativeRun(owner,device,run){
          assert.ok(p.nativeLease,'native custody must be explicitly configured')
          assert.deepEqual([owner,device,run],[p.run.userId,p.device.id,p.run.id])
          ;(p.nativeRunCalls??=[]).push([owner,device,run]);return {ownerId:owner,runId:run}
        },
        async nativeLease(use,signal,includeCatalogue){
          assert.ok(p.nativeLease);assert.deepEqual(use,{ownerId:p.run.userId,runId:p.run.id})
          assert.equal(signal.aborted,false);assert.equal(typeof includeCatalogue,'boolean')
          ;(p.nativeLeaseCalls??=[]).push(use);p.nativeLeaseCapabilities.push(includeCatalogue);return p.nativeLease
        }
      }
    }`],
])
registerHooks({
  resolve(specifier,context,next){
    if(specifier==='server-only')return {url:'claim-fixture:empty',shortCircuit:true}
    if(specifier==='next/server')return {url:'claim-fixture:next-server',shortCircuit:true}
    const result=next(specifier,context)
    for(const [suffix,source] of sources)if(result.url.endsWith(suffix))return {url:`claim-fixture:${encodeURIComponent(source)}`,shortCircuit:true}
    return result
  },
  load(url,context,next){
    if(url==='claim-fixture:empty')return {format:'module',source:'export {}',shortCircuit:true}
    if(url==='claim-fixture:next-server')return {format:'module',source:`export {NextResponse,NextRequest} from ${JSON.stringify(nextServer)};export function after(){}`,shortCircuit:true}
    if(url.startsWith('claim-fixture:'))return {format:'module',source:decodeURIComponent(url.slice('claim-fixture:'.length)),shortCircuit:true}
    return next(url,context)
  },
})
