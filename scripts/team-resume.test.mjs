import './credential-diagnostics-offline.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync,readdirSync} from 'node:fs'
import {orderMigrations} from './migration-order.mjs'
import {scopeMigrationBeforeCommit} from './scope-migration-history.mjs'
import {TEAM_DATABASES,TEAM_OIDS,TEAM_PRESERVED_SCOPES,TEAM_CATALOG_QUERIES,teamHash,verifyTeamResumeTargets,verifyTeamResumeEvidence,verifyTeamResumeMetadata,validateTeamResumeState} from './team-resume.mjs'
import {SCOPE_DATABASES,SCOPE_RETAINED_DATABASE,SCOPE_RETIRED_APPROVALS,scopePolicy,scopeUrl} from './scope-acceptance-policy.mjs'
import {scopeExecutionMode} from './scope-acceptance.mjs'
import {teamResumeBootstrap} from '../tests/support/scope-acceptance.mjs'

function fixture() {
  const migrations=orderMigrations(readdirSync('drizzle').filter(x=>x.endsWith('.sql'))).map(name=>{
    const path='drizzle/'+name,sql=readFileSync(path,'utf8'),before=scopeMigrationBeforeCommit(name,sql)
    return {path,sha256:teamHash(sql),target:/^--\s*target:\s*(\w+)/m.exec(sql)?.[1]??'MIKKA_DATABASE_URL',...(before===null?{}:{beforeCommitSha256:teamHash(before)})}
  })
  const predecessor={candidate:'a15fc81d3a6ae4d4ac56965862c49fdeea99e8af',resource:{name:'mikka-issue184-pg',id:'memory-original-server',image:'memory-image',volume:'memory-volume',role:'postgres',address:'127.0.0.1:55484',adminDb:'issue184_e2e',mustAlreadyBeRunning:true},migrations}
  const journal=[],actual=[]
  for(const [index,file]of migrations.entries()){
    const id='team:migrate:'+(index+1)
    journal.push({event:'query-attempt',id,sqlSha256:file.beforeCommitSha256??file.sha256},{event:'query-result',id,ok:true})
  }
  for(const [i,database]of TEAM_DATABASES.entries()) {
    const counts=[{name:'schema_migrations',rows:[63,7][i]},...Array.from({length:[82,11][i]},(_,n)=>({name:'synthetic_table_'+n,rows:0}))]
    const ledger=migrations.filter(file=>(file.target==='DATABASE_URL')===(i===1)).map(file=>({name:file.path.split('/').at(-1)})).sort((a,b)=>a.name<b.name?-1:1)
    const catalog=Object.fromEntries(Object.keys(TEAM_CATALOG_QUERIES).map(key=>[key,[]]))
    actual.push({database,identity:{database,oid:TEAM_OIDS[i],role:'postgres'},counts,ledger,catalog,connections:[]})
    for(const stage of ['after-migration','failure-readback'])journal.push({event:'snapshot',database,stage,counts})
    journal.push({event:'ledger-readback',database,count:ledger.length,sha256:teamHash(JSON.stringify(ledger))})
  }
  const data={predecessor,result:{candidate:predecessor.candidate,manifestHash:teamHash(JSON.stringify(predecessor)),failed:true,pendingCount:0,queryCounts:{team:3,'team:migrate':155},created:TEAM_DATABASES.map((name,i)=>[name,TEAM_OIDS[i]])},journal,catalog:{passed:true,resource:predecessor.resource,states:actual}}
  const bytes=new Map(),evidence=[]
  const set=(kind,value)=>{
    data[kind]=value;const path='memory:'+kind,b=Buffer.from(kind==='journal'?value.map(x=>JSON.stringify(x)).join('\n'):JSON.stringify(value));bytes.set(path,b)
    const entry=evidence.find(x=>x.kind===kind)
    if(entry)entry.sha256=teamHash(b);else evidence.push({kind,path,sha256:teamHash(b)})
  }
  for(const [kind,value]of Object.entries(data))set(kind,value)
  const manifest={resource:{...predecessor.resource},mode:'team-after-migrated-empty',databases:TEAM_DATABASES,approvalTransfer:false,retiredApprovalIds:SCOPE_RETIRED_APPROVALS,preservedDatabases:TEAM_PRESERVED_SCOPES,migrations,resume:{evidence,catalogQuerySha256:Object.fromEntries(Object.entries(TEAM_CATALOG_QUERIES).map(([key,sql])=>[key,teamHash(sql)])),states:actual.map(row=>({database:row.database,oid:row.identity.oid,owner:'postgres',counts:structuredClone(row.counts),ledgerSha256:teamHash(JSON.stringify(row.ledger)),catalogSha256:teamHash(JSON.stringify(row.catalog))}))}}
  return {manifest,actual,data,set,read:path=>bytes.get(path)}
}

test('team-only proof binds exact successful SQL receipts,63/7ledger, empty snapshots and separate readonly catalog',()=>{
  const f=fixture(),before=JSON.stringify(f.manifest)
  assert.equal(verifyTeamResumeEvidence(f.manifest,f.read).length,2)
  for(const [i,state]of f.manifest.resume.states.entries())assert.equal(validateTeamResumeState(state,f.actual[i]).businessRows,0)
  assert.equal(JSON.stringify(f.manifest),before)
})
test('changed historical work, ownership, catalog proof, query inventory or any business row fails closed',()=>{
  const mutations=[
    f=>{f.data.result.queryCounts.team=4;f.set('result',f.data.result)},
    f=>{f.data.result.created[0][1]='other';f.set('result',f.data.result)},
    f=>{f.data.journal.find(x=>x.event==='query-result').ok=false;f.set('journal',f.data.journal)},
    f=>{f.manifest.resume.states[0].counts[1].rows=1},
    f=>{f.manifest.resume.catalogQuerySha256.columns='changed'},
    f=>{f.data.catalog.states[0].identity.role='other';f.set('catalog',f.data.catalog)},
    f=>{f.manifest.resource.volume='replacement'},
    f=>{f.manifest.databases=[SCOPE_DATABASES.scope,TEAM_DATABASES[1]]},
  ]
  for(const mutate of mutations){const f=fixture();mutate(f);assert.throws(()=>verifyTeamResumeEvidence(f.manifest,f.read),/team/)}
})
test('live fingerprint, ledger, OID, emptiness and competing client are checked before adoption',()=>{
  const mutations=[x=>{x.identity.oid='other'},x=>{x.counts[1].rows=1},x=>{x.ledger.pop()},x=>{x.catalog.columns=[{changed:true}]},x=>{x.connections=[{pid:123}]}]
  for(const mutate of mutations){const f=fixture();mutate(f.actual[0]);assert.throws(()=>validateTeamResumeState(f.manifest.resume.states[0],f.actual[0]),/team resume/)}
  const rows=[...TEAM_PRESERVED_SCOPES.map(x=>({datname:x.name,oid:x.oid,owner:x.owner})),...TEAM_DATABASES.map((datname,i)=>({datname,oid:TEAM_OIDS[i],owner:'postgres'}))]
  verifyTeamResumeMetadata(rows);rows[0].oid='other';assert.throws(()=>verifyTeamResumeMetadata(rows),/metadata mismatch/)
})
test('team-only ownership grants no CREATE, init, replay, ledger, scope bucket or scope database access',()=>{
  const f=fixture(),events=[],p=scopePolicy(f.manifest.migrations,x=>events.push(x),{allowTeamResume:true})
  p.adoptRetainedTeam(f.actual.map(x=>x.identity))
  assert.equal(p.state.resumed.size,2);assert.equal(p.state.created.size,0)
  for(const database of [SCOPE_RETAINED_DATABASE,SCOPE_DATABASES.scope])assert.throws(()=>p.connect('team',{url:scopeUrl(database)}),/mismatch/)
  assert.throws(()=>p.connect('scope',{url:scopeUrl(SCOPE_DATABASES.scope)}),/bucket mismatch/)
  assert.throws(()=>p.grant('team',{url:scopeUrl('issue184_e2e'),text:`create database "${TEAM_DATABASES[0]}"`}),/cannot create/)
  assert.throws(()=>p.grant('team',{url:scopeUrl(TEAM_DATABASES[0]),text:readFileSync(f.manifest.migrations[0].path,'utf8')}),/initialization/)
  assert.throws(()=>p.grant('team',{url:scopeUrl(TEAM_DATABASES[0]),text:'insert into schema_migrations (name) values ($1)'}),/ledger/)
  assert.throws(()=>p.migrationCall('team'),/migration child denied/)
  assert.equal(events.filter(x=>x.event==='query-attempt').length,0)
})
test('only separate team command and exact bootstrap acknowledgement can skip initialization',async()=>{
  const f=fixture();verifyTeamResumeTargets(f.manifest)
  assert.doesNotThrow(()=>scopeExecutionMode('--run-team',f.manifest))
  assert.throws(()=>scopeExecutionMode('--run',f.manifest),/fresh exclusive/)
  for(const old of SCOPE_RETIRED_APPROVALS)assert.throws(()=>scopeExecutionMode('--run-team',f.manifest,old),/new approval/)
  assert.equal(await teamResumeBootstrap(...TEAM_DATABASES),false)
  globalThis.scopeAcceptance={resumeTeam:async databases=>({resumed:true,bootstrapReexecuted:false,databases})}
  try{
    assert.equal(await teamResumeBootstrap(...TEAM_DATABASES),true)
    globalThis.scopeAcceptance.resumeTeam=async()=>({resumed:true,bootstrapReexecuted:true,databases:TEAM_DATABASES})
    await assert.rejects(teamResumeBootstrap(...TEAM_DATABASES),/acknowledgement mismatch/)
  }finally{delete globalThis.scopeAcceptance}
})
