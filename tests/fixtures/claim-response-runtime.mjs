// In-memory claim boundary tests. No sockets, providers or database connections.
import { registerHooks } from 'node:module'
const nextServer = import.meta.resolve('next/server')
const modelContract = new URL('../../lib/model-admission/contract.ts', import.meta.url).href
const dbSource = `import {PgDialect} from ${JSON.stringify(import.meta.resolve('drizzle-orm/pg-core'))}

function query(columns){
  let table
  const q={from(value){table=value[Object.getOwnPropertySymbols(value).find(s=>s.description==='drizzle:Name')];return q},innerJoin(){return q},where(){return q},
    async limit(){const p=globalThis.claimResponseProbe;return table==='agent_runs'?[(columns?.sessionId&&p.lost)?p.lost:{...p.run}]:table==='agents'?[p.agent]:[p.repo]},
    async for(){const p=globalThis.claimResponseProbe;p.locks.push(table);return table==='issues'?[p.issue]:[{run:{...p.run},enabled:true}]}}
  return q
}
function update(value){
  const table=value[Object.getOwnPropertySymbols(value).find(s=>s.description==='drizzle:Name')]
  return {set(values){return {async where(condition){
    const p=globalThis.claimResponseProbe;(p.updates??=[]).push({table,values:{...values}})
    await p.beforeUpdate?.(table,values)
    // Evaluate the route's real WHERE (column = value conjuncts) against the in-memory run.
    const rendered=new PgDialect().sqlToQuery(condition)
    const terms=[...rendered.sql.matchAll(/"agent_runs"\\."(\\w+)" = \\$(\\d+)/g)]
    if(rendered.sql.replace(/"agent_runs"\\."\\w+" = \\$\\d+|[() ]|and/g,'')!=='')throw new Error('unsupported claim WHERE: '+rendered.sql)
    const same=(a,b)=>a instanceof Date||b instanceof Date?a!=null&&b!=null&&new Date(a).getTime()===new Date(b).getTime():a===b
    if(table==='agent_runs'&&terms.every(([,column,index])=>same(p.run[column],rendered.params[Number(index)-1])))Object.assign(p.run,values)
  }}}}
}
export const db={select:query,update,transaction:async fn=>{const p=globalThis.claimResponseProbe;p.transactions++;const error=p.transactionErrors.shift();if(error)throw error;return fn({select:query})}}
export const pool={}
`
const sources = new Map([
  ['/lib/device-route.ts', 'export const withDeviceRoute=handler=>handler'],
  ['/lib/model-admission/runtime.ts', `import {ModelAdmissionError} from ${JSON.stringify(modelContract)};export async function assertUnmanagedModelTransport(scope,model){const p=globalThis.claimResponseProbe;p.preparation.push('model-admission');(p.modelAdmissionScopes??=[]).push(scope);(p.modelAdmissionCalls??=[]).push({scope,model});if(p.modelAdmissionDeniedWorkspace===scope.workspaceId)throw new ModelAdmissionError('modelRouteDenied')};export async function assertSubscriptionModelTransport(scope,model,route){const p=globalThis.claimResponseProbe;(p.subscriptionAdmissionCalls??=[]).push({scope,model,route});await assertUnmanagedModelTransport(scope,model)}`],
  ['/lib/db/index.ts', dbSource],
  ['/lib/device-link.ts', 'export async function authenticateDevice(){const p=globalThis.claimResponseProbe;return Object.hasOwn(p,"caller") ? (p.caller && {tokenId:"synthetic-device-token",...p.caller}) : {userId:"member",tokenId:"synthetic-device-token"}};export async function ownedDevice(){return globalThis.claimResponseProbe.device}'],
  ['/lib/device-repositories.ts', 'export async function readRepositorySettings(){globalThis.claimResponseProbe.preparation.push("settings");return null}'],
  ['/lib/agent-tool-approval/policy-store.ts', 'export async function readCliRunPolicy(){const p=globalThis.claimResponseProbe;p.preparation.push("policy");return structuredClone(p.cliPolicy)}'],
  ['/lib/self-improvement/server.ts', 'export const skillAssignments={async preflight(){globalThis.claimResponseProbe.preparation.push("skill-preflight")},async recordClaim(){globalThis.claimResponseProbe.preparation.push("skill-claim")}};export async function claimBenchmarkAssignment(){globalThis.claimResponseProbe.preparation.push("benchmark-claim")}'],
  ['/lib/factory/runtime.ts', 'export async function guardFactoryClaim(){return {}}'],
  ['/lib/factory/questions/retry.ts', 'export async function blockQuestionRetry(){const p=globalThis.claimResponseProbe;p.preparation.push("question-retry");if(p.questionRetryBlocked){p.run.status="failed";p.run.stopReason="blocked"};return p.questionRetryBlocked}'],
  ['/lib/run-publications.ts', 'export async function prepareRunPublication(){const p=globalThis.claimResponseProbe;p.preparation.push("publication");return structuredClone(p.publication)};export async function persistRunCompletion(_owner,_run,completion){const p=globalThis.claimResponseProbe;if(completion.stopReason==="error"&&completion.report.summary==="The task is no longer available to this thread."){p.preparation.push("issue-unavailable");return}if(!p.run.retryOf||completion.stopReason!=="blocked")throw new Error("unexpected publication failure");p.preparation.push("blocked-recovery");p.run.status="stopped";p.run.stopReason="blocked"}'],
  ['/lib/issue-team-access.ts', 'export async function issueTeamAccess(){return {allowed:globalThis.claimResponseProbe.memberAllowed}}'],
  ['/lib/issue-access.ts', 'export async function issueForUser(){const p=globalThis.claimResponseProbe;if(p.issueAccessError)throw p.issueAccessError;return p.memberAllowed&&!p.issue?.content?.attrs?.mikka?.deletedAt?p.issue:null}'],
  ['/lib/mcp/worker.ts', 'export async function issueRunToken(){const p=globalThis.claimResponseProbe;p.preparation.push("token");await p.beforeToken?.();if(p.tokenError)throw new Error("synthetic token refusal");return {token:"synthetic-only"}}'],
  ['/lib/computer/claim.ts', `
    function claimTransaction(){
      const p=globalThis.claimResponseProbe
      return {query(sql,args){
        if(!sql.startsWith('UPDATE agent_runs SET "deviceTokenId"=$2')||args[0]!==p.run.id||args[1]!=="synthetic-device-token"||args[2]!=="member")throw new Error("unexpected SQL in claim fixture")
        p.run.deviceTokenId=args[1]
        return Promise.resolve({rows:[],rowCount:1})
      }}
    }
    export async function claimLocalRun(_pool,_run,_device,lease,_binding,beforeClaim,afterClaim){
      const p=globalThis.claimResponseProbe;const tx=claimTransaction()
      if(typeof beforeClaim!=="function"||typeof afterClaim!=="function")throw new Error("claim callbacks missing")
      if(await beforeClaim(tx)===false)return "unavailable"
      p.preparation.push("claim");p.run.status="preparing";p.run.leaseExpiresAt=lease
      await afterClaim(tx);return "claimed"
    }
    export async function claimCloudRun(_pool,_actor,_run,_device,lease,_binding,beforeClaim,afterClaim){
      const p=globalThis.claimResponseProbe;const tx=claimTransaction()
      if(!p.cloud)throw new Error("unexpected cloud claim")
      if(await beforeClaim(tx)===false)return null
      p.preparation.push("claim");p.run.status="preparing";p.run.leaseExpiresAt=lease
      await afterClaim(tx);return {botId:"bot",ownerId:"member",display:":1",policyVersion:1,permission:"ask"}
    }
  `],
  ['/lib/computer/native-run-binding.ts', 'export async function nativeRunBinding(){return globalThis.claimResponseProbe.cloud.subscription}'],
  ['/lib/secrets/runtime.ts', 'export function remoteRepositoryRef(url){return url};export async function taskSecretInjection(...args){const p=globalThis.claimResponseProbe;p.preparation.push("secrets");(p.secretReads??=[]).push(args);return p.secretInjection??{env:{},secretNames:[]}}'],
  ['/lib/run-leases.ts', 'export async function latestCheckpoint(){const p=globalThis.claimResponseProbe;p.preparation.push("checkpoint");return structuredClone(p.checkpoint)}'],
  ['/lib/subscription-runtime.ts', 'export function subscriptionRuntime(){throw new Error("unexpected subscription access")}'],
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
