import assert from 'node:assert/strict'
import test from 'node:test'
import {retainedScope70Fixture} from '../tests/support/scope-history-fixture.mjs'
import {createHash} from 'node:crypto'
import {scopeResumeSchema,verifyScopeResumeEvidence,validateScopeResumeState} from './scope-resume.mjs'
import {scopePolicy,scopeUrl,SCOPE_RETAINED_DATABASE} from './scope-acceptance-policy.mjs'
import {scopeExecutionMode} from './scope-acceptance.mjs'
import {scopeResumeBootstrap} from '../tests/support/scope-acceptance.mjs'
const hash=value=>createHash('sha256').update(value).digest('hex')
const files={predecessor:'memory:predecessor',result:'memory:result',readback:'memory:readback',journal:'memory:journal'}
function fixture(){
  // Synthetic filesystem/journal model only: no ledger rows or DB records are written.
  const {migrations,readSource}=retainedScope70Fixture()
  const previous={candidate:'2da9834018a3a0aa0f4fc8b8c4fd965e4d51be39',migrations}
  const ledger=migrations.map(file=>({name:file.path.split('/').at(-1)})).sort((a,b)=>a.name<b.name?-1:1)
  const tables=[{name:'schema_migrations',rows:70},...Array.from({length:93},(_,n)=>({name:'synthetic_table_'+n,rows:0}))]
  const journal=[]
  for(const [index,file]of migrations.entries()){const id='scope:migrate:'+(index+1);journal.push({event:'query-attempt',id,sqlSha256:file.beforeCommitSha256??file.sha256},{event:'query-result',id,ok:true})}
  journal.push({event:'worker-finished',phase:'scope',mode:'migrate'},{event:'snapshot',stage:'failure-readback',counts:tables},{event:'ledger-readback',sha256:hash(JSON.stringify(ledger))})
  const result={candidate:previous.candidate,manifestHash:hash(JSON.stringify(previous)),pendingCount:0,failed:true,queryCounts:{scope:2,'scope:migrate':155}}
  const snapshot={tableCount:94,totalCommittedRows:70,nonemptyTables:[{name:'schema_migrations',rows:70}]}
  const readback={teamStageStarted:false,fixtureMigrationReplays:0,listenersStarted:0,providerRequests:0,remainingWorkerConnections:[],targets:[{oid:'65537'}],snapshots:[snapshot,snapshot]}
  const bytes=new Map([[files.predecessor,Buffer.from(JSON.stringify(previous))],[files.result,Buffer.from(JSON.stringify(result))],[files.readback,Buffer.from(JSON.stringify(readback))],[files.journal,Buffer.from(journal.map(row=>JSON.stringify(row)).join('\n'))]])
  const manifest={mode:'resume-scope-after-bootstrap',migrations:previous.migrations,resume:{database:SCOPE_RETAINED_DATABASE,oid:'65537',owner:'postgres',predecessorManifestSha256:hash(bytes.get(files.predecessor)),schema:scopeResumeSchema(previous.migrations,readSource),evidence:Object.entries(files).map(([kind,path])=>({kind,path,sha256:hash(bytes.get(path))}))}}
  const read=path=>bytes.get(path)??readSource(path)
  const expected=verifyScopeResumeEvidence(manifest,read)
  const bodies={}
  for(const file of manifest.migrations)for(const match of readSource(file.path).toString('utf8').matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w."]+)\s*\([^)]*\)[\s\S]*?\bas\s+(\$[\w]*\$)([\s\S]*?)\2\s*;/gi))bodies[match[1]]=match[3]
  const actual={identity:{database:SCOPE_RETAINED_DATABASE,oid:'65537',role:'postgres'},counts:structuredClone(expected.tables),workerConnections:[],ledger:manifest.migrations.map(file=>({name:file.path.split('/').at(-1)})).sort((a,b)=>a.name<b.name?-1:1),functions:Object.entries(bodies).map(([name,body])=>({name,body,language:'plpgsql',securityDefiner:false,arguments:'',returns:'trigger',config:null,volatility:'v',owner:'postgres'})),triggers:Object.entries(manifest.resume.schema.triggers).map(([key,definition])=>({table:key.split('/')[0],name:key.split('/')[1],enabled:'O',definition})),columns:Object.entries(manifest.resume.schema.columns).map(([key,value])=>({table:key.split('/')[0],name:key.split('/')[1],...value})),constraints:[{table:'linear_comment_links',definition:'FOREIGN KEY ("issueLinkId") REFERENCES public.linear_issue_links(id) ON DELETE CASCADE'}],indexes:[]}
  return {manifest,bytes,read,expected,actual}
}
test('explicit resume accepts the retained successful70-payload evidence without adding ledger markers',()=>{
  const f=fixture(),before=JSON.stringify(f.manifest)
  const result=validateScopeResumeState(f.manifest.resume,f.expected,f.actual)
  assert.equal(result.businessRows,0);assert.equal(result.ledgerRows,70)
  assert.equal(JSON.stringify(f.manifest),before)
})
test('fresh mode cannot adopt a DB; proof/hash uncertainty or changed SQL cannot enable resume',()=>{
  const f=fixture();f.manifest.mode='fresh';assert.throws(()=>verifyScopeResumeEvidence(f.manifest,f.read),/explicit/)
  f.manifest.mode='resume-scope-after-bootstrap';f.bytes.set(files.result,Buffer.from('{}'));assert.throws(()=>verifyScopeResumeEvidence(f.manifest,f.read),/hash mismatch/)
  const changed=fixture();changed.manifest.migrations=structuredClone(changed.manifest.migrations);changed.manifest.migrations[0].sha256='changed';assert.throws(()=>verifyScopeResumeEvidence(changed.manifest,changed.read),/payload manifest changed/)
})
test('live changed OID, rows, ledger, worker or schema stops resume before fixture writes',()=>{
  const mutations=[f=>{f.actual.identity.oid='other'},f=>{f.actual.counts[0].rows=1},f=>{f.actual.ledger.pop()},f=>{f.actual.workerConnections=[{pid:123}]},f=>{f.actual.functions[0].body+='changed'},f=>{f.actual.triggers[0].enabled='D'},f=>{f.actual.columns[0].default='wrong'},f=>{f.actual.constraints=[]}]
  for(const mutate of mutations){const f=fixture();mutate(f);assert.throws(()=>validateScopeResumeState(f.manifest.resume,f.expected,f.actual),/resume/)}
})
test('explicit retained ownership is separate from creation and refuses bootstrap/create replay',()=>{
  const f=fixture(),p=scopePolicy(f.manifest.migrations,()=>{},{allowResume:true})
  p.adoptRetainedScope(f.actual.identity)
  assert.equal(p.state.created.size,0);assert.equal(p.state.resumed.size,1)
  const url=scopeUrl(SCOPE_RETAINED_DATABASE)
  assert.throws(()=>p.connect('scope',{url}),/mismatch/)
  assert.throws(()=>p.grant('scope',{url:scopeUrl('issue184_e2e'),text:`create database "${SCOPE_RETAINED_DATABASE}"`}),/only its exact/)
  const file=f.manifest.migrations[0]
  assert.throws(()=>p.grant('scope:migrate',{url,text:f.read(file.path).toString('utf8')}),/mismatch/)
})
test('bootstrap skip requires the explicit supervisor capability; failure propagates without a fake stdout success',async()=>{
  assert.equal(await scopeResumeBootstrap(SCOPE_RETAINED_DATABASE),false)
  let calls=0
  globalThis.scopeAcceptance={resumeScope:async name=>{assert.equal(name,SCOPE_RETAINED_DATABASE);calls++}}
  try{assert.equal(await scopeResumeBootstrap(SCOPE_RETAINED_DATABASE),true);assert.equal(calls,1);globalThis.scopeAcceptance.resumeScope=async()=>{throw Error('read-only precondition changed')};await assert.rejects(scopeResumeBootstrap(SCOPE_RETAINED_DATABASE),/precondition changed/)}finally{delete globalThis.scopeAcceptance}
})


test('resume requires a separate command and policy; fresh existing-target protection is not disabled',()=>{
  const f=fixture()
  assert.throws(()=>scopeExecutionMode('--run',f.manifest),/fresh exclusive scope/)
  assert.throws(()=>scopeExecutionMode('--run-resume',{mode:'fresh'}),/fresh exclusive scope/)
  assert.throws(()=>scopeExecutionMode('--run-resume',f.manifest),/fresh exclusive scope/)
  assert.doesNotThrow(()=>scopeExecutionMode('--run',{mode:'fresh-exclusive-scope'}))
  assert.throws(()=>scopePolicy(f.manifest.migrations).adoptRetainedScope(f.actual.identity),/explicit resume policy required/)
})
