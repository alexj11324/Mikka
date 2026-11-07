import assert from 'node:assert/strict'
import { test, mock } from 'node:test'

// Exercise the actual ops runner without a database, credentials or network.
// The fixture includes an eligible acquisition and an account deletion fence.
const reports = [], calls = []
let mode = 'dry-run', failExpiry = false, changedProtected = false, protectedReads = 0
const originalExitCode = process.exitCode
const query = async (sql, args) => {
  calls.push({ sql, args })
  if (sql.startsWith('SELECT c.id,c."ownerId"')) return { rows: [
    { id: 'eligible', ownerId: 'active-owner', provider: 'codex', guarded: false },
    { id: 'fenced', ownerId: 'deleting-owner', provider: 'claude', guarded: true },
  ] }
  if (sql.startsWith('SELECT j.stage')) return {rows:[{stage:'storage_pending',count:1}]}
  if (sql.startsWith('SELECT c.id,md5')) {
    protectedReads++
    assert.deepEqual(args, [['eligible']], 'the fenced row must be in the preserved set')
    return {rows:[{id:'fenced',digest:changedProtected && protectedReads>1?'changed':'original'}]}
  }
  if (sql.startsWith('SELECT count(*)')) return { rows:[{n:0}] }
  return { rows:[] }
}
const client = {query,release(){calls.push({sql:'release'})}}
mock.module('node:child_process',{namedExports:{execFileSync(){}}})
mock.module('node:fs',{namedExports:{mkdirSync(){},writeFileSync(path,body){reports.push(JSON.parse(body))}}})
mock.module(new URL('../../lib/db/index.ts',import.meta.url).href,{namedExports:{pool:{query,connect:async()=>client,end:async()=>{}}}})
mock.module(new URL('../../lib/workspace-db.ts',import.meta.url).href,{namedExports:{workspacePool:{end:async()=>{}}}})
mock.module(new URL('../../lib/demo-device-cleanup.ts',import.meta.url).href,{namedExports:{removeDemoDevices:async apply=>{
  calls.push({sql:apply?'devices_apply':'devices_plan'})
  return {devices:0,activeRuns:0,stoppedRuns:0,removedDevices:0}
}}})
mock.module(new URL('../../lib/device-presence.ts',import.meta.url).href,{namedExports:{deviceOnlineStates:async()=>new Map()}})
mock.module(new URL('../../lib/subscription-acquire-expiry.ts',import.meta.url).href,{namedExports:{expireSubscriptionAcquisitions:async (connection,ownerId)=>{
  assert.equal(connection,client)
  assert.equal(ownerId,'active-owner','never run a global sweep or touch a deleting owner')
  if(failExpiry)throw Object.assign(new Error('private database text must never leave this process'),{code:'55000',routine:'exec_stmt_raise'})
  return {expired:1,ownerIds:[ownerId]}
}}})
mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>({build:'a'.repeat(40)})}))

for(const scenario of ['dry-run','apply','sql-failure','protected-change']) test(scenario,async()=>{
  mode=scenario==='apply'?'apply':'dry-run';failExpiry=scenario==='sql-failure';changedProtected=scenario==='protected-change';protectedReads=0;calls.length=0
  const env = {...process.env}
  Object.assign(process.env,{GITHUB_REPOSITORY:'alexj11324/Mikka',GITHUB_REF:'refs/heads/ops/1515-1517-acceptance',APPLICATION_SHA:'a'.repeat(40),MIKKA_DATABASE_URL:'fixture',DATABASE_URL:'fixture',CLEANUP_MODE:mode})
  delete process.env.VERCEL;delete process.env.WORKFLOW_TARGET_WORLD;delete process.env.NODE_ENV
  try {
    await import('./issues-1515-1517-cleanup.ts?scenario='+scenario)
    const report=reports.at(-1)
    assert.equal(report.emptyConnectionsFound,2)
    assert.equal(report.emptyConnectionsPreservedForAccountDeletion,1)
    const failed=failExpiry || changedProtected
    assert.equal(report.status,failed?'failed':'complete')
    assert.equal(calls.some(call=>call.sql==='COMMIT'),scenario==='apply')
    assert.equal(calls.some(call=>call.sql==='ROLLBACK'),scenario!=='apply')
    assert.equal(calls.some(call=>call.sql==='devices_apply'),scenario==='apply')
    if(failExpiry){assert.equal(report.failedStage,'subscription_expire');assert.equal(report.sqlstate,'55000');assert.equal(report.subscriptionTransactionRolledBack,true)}
    if(changedProtected)assert.equal(report.error,'cleanup_protected_subscription_changed')
    assert.doesNotMatch(JSON.stringify(report),/private database text|deleting-owner|active-owner/)
  } finally {
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key]
    Object.assign(process.env,env);process.exitCode=originalExitCode
  }
})
