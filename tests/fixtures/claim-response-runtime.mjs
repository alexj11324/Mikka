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
export const db={select:query,transaction:async fn=>{const p=globalThis.claimResponseProbe;p.transactions++;const error=p.transactionErrors.shift();if(error)throw error;return fn({select:query})}}
export const pool={}
`
const sources = new Map([
  ['/lib/db/index.ts', dbSource],
  ['/lib/device-link.ts', 'export async function authenticateDevice(){return {userId:"member"}};export async function ownedDevice(){return {enabled:true,kind:"local",harnesses:[]}}'],
  ['/lib/issue-team-access.ts', 'export async function issueTeamAccess(){return {allowed:globalThis.claimResponseProbe.memberAllowed}}'],
  ['/lib/mcp/worker.ts', 'export async function issueRunToken(){const p=globalThis.claimResponseProbe;await p.beforeToken?.();if(p.tokenError)throw new Error("synthetic token refusal");return {token:"synthetic-only"}}'],
  ['/lib/computer/claim.ts', 'export async function claimLocalRun(_pool,_run,_device,lease){const p=globalThis.claimResponseProbe;p.run.status="preparing";p.run.leaseExpiresAt=lease;return "claimed"};export async function claimCloudRun(){throw new Error("unexpected cloud claim")}'],
  ['/lib/run-leases.ts', 'export async function latestCheckpoint(){throw new Error("unexpected checkpoint read")}'],
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
