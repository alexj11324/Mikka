import test from 'node:test'
import assert from 'node:assert/strict'
import { TARGET, PARAMETERS, QUERIES, projectRow, runGroupFactoryDiagnostic } from './group-factory-diagnostic.mjs'

const environment = () => ({GITHUB_REPOSITORY:'alexj11324/Mikka',GITHUB_REF:'refs/heads/acceptance/proactive-1157-1163',
 GITHUB_EVENT_NAME:'push',GITHUB_RUN_ATTEMPT:'1',DIAGNOSTIC_SOURCE_SHA:TARGET.source,DIAGNOSTIC_SECRET_READ:'success',
 MIKKA_DATABASE_URL:'postgresql://synthetic:private-password@ep-synthetic-pooler.us-east-2.aws.neon.tech/synthetic'})
function harness({failName,failCode='57014',scopeMissing=false,foreign=false,versionDrift=false,endFails=false}={}) {
 const env=environment(),calls=[],seen=[],rows={scope:[{ownerId:TARGET.owner,workspaceId:TARGET.workspace,conversationId:TARGET.group,messageId:TARGET.message,reporterId:TARGET.reporter,
 status:'failed',failureCode:'generation_failed_not_replayed',action:'delegate',operation:'create',decisionSteps:4,prompt:'PRIVATE PROMPT',token:'PRIVATE TOKEN'}],
 receipts:[{messageId:TARGET.message,ownerId:TARGET.owner,reporterId:TARGET.reporter,resultPresent:false}],bindings:[],sourceEvents:[],tasks:[],attempts:[],runs:[],threadMachines:[],reporterRuntime:[]}
 let creates=0,versions=0
 const client={async connect(){calls.push('connect')},on(){},async query(sql,params) {
  calls.push(sql)
  if(sql==="SELECT current_setting('transaction_read_only') AS readonly")return {rows:[{readonly:'on'}]}
  const name=Object.keys(QUERIES).find(name=>QUERIES[name]===sql)
  if(name){seen.push(name);assert.deepEqual(params,[...PARAMETERS]);if(name===failName)throw Object.assign(Error('PRIVATE DSN or provider text'),{code:failCode})
   if(name==='scope'&&scopeMissing)return {rows:[]}
   if(name==='receipts'&&foreign)return {rows:[{ownerId:'another-owner',messageId:TARGET.message}]}
   return {rows:rows[name]}}
  assert.ok(['BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',"SET LOCAL statement_timeout = '10s'","SET LOCAL lock_timeout = '5s'","SET LOCAL idle_in_transaction_session_timeout = '30s'",'ROLLBACK'].includes(sql))
  return {rows:[]}
 },async end(){calls.push('end');if(endFails)throw Error('PRIVATE END ERROR')}}
 return {env,calls,seen,run:()=>runGroupFactoryDiagnostic({env,verifySource:async()=>TARGET.source,
  verifyVersion:async()=>{versions++;if(versionDrift&&versions===2)throw Error('diagnostic_deployment_changed')},
  createClient:options=>{creates++;assert.equal(options.query_timeout,11000);assert.equal(options.statement_timeout,10000);assert.equal(options.connectionTimeoutMillis,10000);return client}}),
  creates:()=>creates}
}
test('fixed read-only transaction executes nine bounded parameterized observations and removes secret input',async()=>{
 const h=harness(),r=await h.run()
 assert.equal(r.status,'observed');assert.equal(r.readOnlyConfirmed,true);assert.equal(r.connectionClosed,true)
 assert.deepEqual(r.completedQueries,Object.keys(QUERIES));assert.equal(h.seen.length,9)
 assert.ok(h.calls.indexOf('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')<h.calls.indexOf(QUERIES.scope))
 assert.equal(h.calls.filter(x=>x==='ROLLBACK').length,1);assert.equal(h.env.MIKKA_DATABASE_URL,undefined)
 assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.ok(!JSON.stringify(r).includes('private-password'))
 assert.equal(r.providerInvoked,false);assert.equal(r.sqlWritesPerformed,false);assert.equal(r.normalApiCleanupPerformed,false)
 assert.equal(r.sharedMachineOwnershipDoesNotProveFixtureCreation,true)
 for(const sql of Object.values(QUERIES)){assert.match(sql,/WITH fixed AS/);assert.match(sql,/LIMIT \d+$/);assert.doesNotMatch(sql,/\b(UPDATE|INSERT|DELETE|CREATE|DROP|ALTER|TRUNCATE|FOR UPDATE)\b/i);assert.doesNotMatch(sql,/\b(prompt|payload|agentDefinition|accessToken|lastAction|logTail)\b/)}
})
test('missing exact owner/group/message scope prevents all dependent reads',async()=>{
 const h=harness({scopeMissing:true}),r=await h.run()
 assert.equal(r.status,'failed');assert.equal(r.error,'diagnostic_scope_mismatch');assert.deepEqual(h.seen,['scope'])
 assert.equal(r.connectionClosed,true);assert.equal(h.calls.filter(x=>x==='ROLLBACK').length,1)
})
test('one SQL timeout retains prior observations, classifies only SQLSTATE and never retries',async()=>{
 const h=harness({failName:'sourceEvents'}),r=await h.run()
 assert.equal(r.status,'failed');assert.equal(r.sqlState,'57014');assert.equal(r.failedPhase,'sourceEvents')
 assert.deepEqual(r.completedQueries,['scope','receipts','bindings']);assert.equal(h.seen.filter(x=>x==='sourceEvents').length,1)
 assert.equal(h.seen.includes('tasks'),false);assert.equal(r.connectionClosed,true)
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE|password|postgresql:/)
})
test('unexpected owner is rejected without publishing foreign identity',async()=>{
 const h=harness({foreign:true}),r=await h.run()
 assert.equal(r.status,'failed');assert.equal(r.error,'diagnostic_owner_mismatch');assert.equal(r.observations.receipts,undefined)
 assert.doesNotMatch(JSON.stringify(r),/another-owner/);assert.equal(r.connectionClosed,true)
})
test('wrong source or unconfirmed named read prevents connection, including workflow reruns',async()=>{
 for(const change of [{DIAGNOSTIC_SOURCE_SHA:'0'.repeat(40)},{DIAGNOSTIC_SECRET_READ:'failure'},{GITHUB_RUN_ATTEMPT:'2'}]){
  const h=harness();Object.assign(h.env,change);const r=await h.run()
  assert.equal(r.status,'failed');assert.equal(h.creates(),0);assert.equal(h.seen.length,0);assert.equal(h.env.MIKKA_DATABASE_URL,undefined)
 }
})
test('deployment drift after snapshot keeps evidence but does not claim success',async()=>{
 const h=harness({versionDrift:true}),r=await h.run()
 assert.equal(r.status,'failed');assert.equal(r.error,'diagnostic_deployment_changed');assert.equal(r.completedQueries.length,9);assert.equal(r.connectionClosed,true)
})
test('projection cannot leak unknown errors, provider text or private JSON; close failure stays failed',async()=>{
 assert.deepEqual(projectRow({failureCode:'provider text with secret',stopReason:'private detail',prompt:'x',agentDefinition:{key:'x'},output:{text:'x'}}),{failureCode:null,stopReason:null})
 const h=harness({endFails:true}),r=await h.run();assert.equal(r.status,'failed');assert.equal(r.connectionClosed,false);assert.doesNotMatch(JSON.stringify(r),/PRIVATE END ERROR/)
})

