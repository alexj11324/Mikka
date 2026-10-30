// In-memory claim boundary tests. No sockets, providers or database connections.
import { registerHooks } from 'node:module'
const dbSource = `
function query(columns){
  let table
  const q={from(value){table=value[Object.getOwnPropertySymbols(value).find(s=>s.description==='drizzle:Name')];return q},innerJoin(){return q},where(){return q},
    async limit(){const p=globalThis.claimResponseProbe;return table==='agent_runs'?[{...p.run}]:table==='agents'?[p.agent]:[p.repo]},
    async for(){const p=globalThis.claimResponseProbe;p.locks.push(table);return table==='issues'?[p.issue]:[{run:{...p.run},enabled:true}]}}
  return q
}
function update(value){
  const table=value[Object.getOwnPropertySymbols(value).find(s=>s.description==='drizzle:Name')]
  return {set(values){return {async where(){
    const p=globalThis.claimResponseProbe;(p.updates??=[]).push({table,values:{...values}})
    // Mirror the route's WHERE: a failure write needs a queued run, an environment write needs the claimed (preparing) run.
    if(table==='agent_runs'&&p.run.status===(values.status==='failed'?'queued':'preparing'))Object.assign(p.run,values)
  }}}}
}
export const db={select:query,update,transaction:async fn=>{const p=globalThis.claimResponseProbe;p.transactions++;const error=p.transactionErrors.shift();if(error)throw error;return fn({select:query})}}
export const pool={}
`
const sources = new Map([
  ['/lib/db/index.ts', dbSource],
  ['/lib/device-link.ts', 'export async function authenticateDevice(){return globalThis.claimResponseProbe.caller??{userId:"member"}};export async function ownedDevice(){return globalThis.claimResponseProbe.device}'],
  ['/lib/device-repositories.ts', 'export async function readRepositorySettings(){globalThis.claimResponseProbe.preparation.push("settings");return null}'],
  ['/lib/agent-tool-approval/policy-store.ts', 'export async function readCliRunPolicy(){const p=globalThis.claimResponseProbe;p.preparation.push("policy");return structuredClone(p.cliPolicy)}'],
  ['/lib/self-improvement/server.ts', 'export const skillAssignments={async preflight(){globalThis.claimResponseProbe.preparation.push("skill-preflight")},async recordClaim(){globalThis.claimResponseProbe.preparation.push("skill-claim")}};export async function claimBenchmarkAssignment(){globalThis.claimResponseProbe.preparation.push("benchmark-claim")}'],
  ['/lib/factory/runtime.ts', 'export async function guardFactoryClaim(){return {}}'],
  ['/lib/factory/questions/retry.ts', 'export async function blockQuestionRetry(){const p=globalThis.claimResponseProbe;p.preparation.push("question-retry");if(p.questionRetryBlocked){p.run.status="failed";p.run.stopReason="blocked"};return p.questionRetryBlocked}'],
  ['/lib/run-publications.ts', 'export async function prepareRunPublication(){const p=globalThis.claimResponseProbe;p.preparation.push("publication");return structuredClone(p.publication)};export async function persistRunCompletion(){throw new Error("unexpected publication failure")}'],
  ['/lib/issue-team-access.ts', 'export async function issueTeamAccess(){return {allowed:globalThis.claimResponseProbe.memberAllowed}}'],
  ['/lib/mcp/worker.ts', 'export async function issueRunToken(){const p=globalThis.claimResponseProbe;p.preparation.push("token");await p.beforeToken?.();if(p.tokenError)throw new Error("synthetic token refusal");return {token:"synthetic-only"}}'],
  ['/lib/computer/claim.ts', 'export async function claimLocalRun(_pool,_run,_device,lease,_binding,beforeClaim,afterClaim){const p=globalThis.claimResponseProbe;const tx={query(){throw new Error("unexpected SQL in ordinary claim fixture")}};if(typeof beforeClaim!=="function"||typeof afterClaim!=="function")throw new Error("claim callbacks missing");if(await beforeClaim(tx)===false)return "unavailable";p.preparation.push("claim");p.run.status="preparing";p.run.leaseExpiresAt=lease;await afterClaim(tx);return "claimed"};export async function claimCloudRun(_pool,_actor,_run,_device,lease,_binding,beforeClaim,afterClaim){const p=globalThis.claimResponseProbe;if(!p.cloud)throw new Error("unexpected cloud claim");if(await beforeClaim({query(){throw new Error("unexpected SQL")}})===false)return null;p.preparation.push("claim");p.run.status="preparing";p.run.leaseExpiresAt=lease;await afterClaim({query(){throw new Error("unexpected SQL")}});return {botId:"bot",ownerId:"member",display:":1",policyVersion:1,permission:"ask"}}'],
  ['/lib/computer/native-run-binding.ts', 'export async function nativeRunBinding(){return globalThis.claimResponseProbe.cloud.subscription}'],
  ['/lib/secrets/runtime.ts', `export {resolveRunSecretsEnvironment} from ${JSON.stringify(new URL('../../lib/secrets/run-environment.ts', import.meta.url).href)};export function remoteRepositoryRef(url){return url};export async function taskSecretEnv(_w,_r,environment){const p=globalThis.claimResponseProbe;p.preparation.push("secrets:"+environment);return {}}`],
  ['/lib/run-leases.ts', 'export async function latestCheckpoint(){globalThis.claimResponseProbe.preparation.push("checkpoint");return null}'],
  ['/lib/subscription-runtime.ts', 'export function subscriptionRuntime(){throw new Error("unexpected subscription access")}'],
])
registerHooks({
  resolve(specifier,context,next){
    if(specifier==='server-only')return {url:'claim-fixture:empty',shortCircuit:true}
    const result=next(specifier,context)
    for(const [suffix,source] of sources)if(result.url.endsWith(suffix))return {url:`claim-fixture:${encodeURIComponent(source)}`,shortCircuit:true}
    return result
  },
  load(url,context,next){
    if(url==='claim-fixture:empty')return {format:'module',source:'export {}',shortCircuit:true}
    if(url.startsWith('claim-fixture:'))return {format:'module',source:decodeURIComponent(url.slice('claim-fixture:'.length)),shortCircuit:true}
    return next(url,context)
  },
})
