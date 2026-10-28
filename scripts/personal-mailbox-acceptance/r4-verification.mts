/** Acceptance evidence only. No DB, credentials, grants or runtime capability. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants,openSync,closeSync,writeSync,fstatSync,lstatSync,realpathSync,readFileSync } from 'node:fs'
import { join } from 'node:path'
type Binding={runId:string;newTokenId:string}
type Result={rowCount:number|null;rows:Record<string,unknown>[]}
const names=['lease.original','lease.refreshed','lease.restored','lease.refresh','lease.restore','token.insert','token.revoke','tokens.final','fingerprints.baseline','fingerprints.final','acl.baseline','acl.final'] as const
type Name=typeof names[number]
type Row=Record<string,string|number|boolean|null>
type Payload={rowCount:number|null;requestedIds:string[];rows:Row[];digest:string}
type RecordEvent={sequence:number;at:string;name:Name|'query.error'|'start'|'finish';data:any;previousSHA:string;sha256:string}
const tables=Object.freeze(['user','issues','devices','agents','bots','agent_runs','run_tokens','session_mailboxes','run_messages','coordinator_events','agent_kit_heads','agent_kit_versions','agent_kit_executions','mikka_workspace_members'])
// Frozen schema contract, not a scope inferred from an incomplete DB response.
const aclColumns={agent_kit_heads:['owner_id','bot_key','bot_id','workspace_id','active_version','next_version'],agent_kit_versions:['id','owner_id','bot_key','version','definition','digest','source','request_key','base_version','created_at'],agent_kit_executions:['id','owner_id','bot_key','execution_key','version_id','snapshot','status','started_at','finished_at'],mikka_workspace_members:['workspaceId','userId','name','email','role','status','createdAt']}
export const verificationScope=Object.freeze({tables,acl:Object.freeze([{kind:'role',name:'mailbox287'},...tables.map(name=>({kind:'table_acl',name})),...Object.entries(aclColumns).flatMap(([table,columns])=>columns.map(column=>({kind:'column_acl',name:table+'.'+column}))),{kind:'run_filenode',name:'agent_runs'}].map(row=>Object.freeze(row)))})
type Expected={sourceSHA:string;manifestSHA:string;roundId:string;lastSHA:string}
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s)
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const canonical=(v:any):string=>JSON.stringify(v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])))
function exact(v:unknown){
 assert.equal(typeof v,'string','Expected exact PG timestamp')
 const value=v as string;assert.match(value,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/,'Expected six-digit UTC PG timestamp')
 assert.equal(new Date(value).toISOString(),value.slice(0,23)+'Z','Invalid UTC timestamp')
 return value // Date is for validation only: never serialize/round the PG value.
}
function bindingsValid(bindings:Binding[]){
 assert.equal(bindings.length,2);assert.ok(bindings.every(b=>uuid(b.runId)&&uuid(b.newTokenId)))
 assert.equal(new Set(bindings.map(b=>b.runId)).size,2);assert.equal(new Set(bindings.map(b=>b.newTokenId)).size,2)
}
function project(name:Name,result:Result,ids:string[],bindings:Binding[]):Payload{
 assert.ok(names.includes(name));assert.ok(Array.isArray(result.rows)&&result.rows.length<=200)
 assert.ok(result.rowCount===null||Number.isSafeInteger(result.rowCount)&&result.rowCount!>=0)
 const token=name.startsWith('token')||name==='tokens.final',allowed=bindings.map(b=>token?b.newTokenId:b.runId)
 assert.ok(ids.length<=2&&new Set(ids).size===ids.length&&ids.every(id=>allowed.includes(id)))
 let rows:Row[]
 if(name.startsWith('lease.'))rows=result.rows.map(row=>{
  assert.ok(typeof row.id==='string'&&allowed.includes(row.id),'Unexpected lease identity')
  const value=exact(row.leaseExact);return{id:row.id,leaseExact:value,leaseSHA:hash(value)}
 })
 else if(token)rows=result.rows.map((row):Row=>{
  const b=bindings.find(b=>b.newTokenId===row.id);assert.ok(b&&row.runId===b.runId,'Unexpected token binding')
  if(name==='token.insert')return{id:b.newTokenId,runId:b.runId}
  assert.equal(typeof row.revoked,'boolean');const value=row.revokedExact===null?null:exact(row.revokedExact)
  return{id:b.newTokenId,runId:b.runId,revoked:row.revoked as boolean,revokedExact:value,revokedSHA:value===null?null:hash(value)}
 })
 else if(name.startsWith('fingerprints.'))rows=result.rows.map(row=>{
  assert.ok(typeof row.table_name==='string'&&tables.includes(row.table_name),'Unexpected protected table')
  assert.ok(Number.isSafeInteger(row.count)&&(row.count as number)>=0);assert.match(String(row.digest),/^[a-f0-9]{64}$/)
  if(row.count===0)assert.equal(row.digest,hash(''),'Empty protected table must have the empty digest')
  return{table:row.table_name,count:row.count as number,digest:row.digest as string}
 })
 else rows=result.rows.map(row=>{
  assert.ok(['role','table_acl','column_acl','run_filenode'].includes(String(row.kind)),'Unexpected ACL kind')
  assert.ok(typeof row.name==='string'&&/^[A-Za-z0-9_.]{1,128}$/.test(row.name),'Invalid ACL identity')
  if(row.kind==='role')assert.equal(row.name,'mailbox287')
  else if(row.kind==='column_acl')assert.ok(tables.includes(row.name.split('.')[0]))
  else assert.ok(tables.includes(row.name))
  assert.ok(typeof row.descriptor==='string'&&row.descriptor.length<=16384)
  return{kind:row.kind as string,name:row.name,descriptorSHA:hash(row.descriptor)}
 })
 rows.sort((a,b)=>canonical(a).localeCompare(canonical(b)))
 if(name.startsWith('fingerprints.'))assert.equal(new Set(rows.map(r=>r.table)).size,rows.length,'Duplicate protected table')
 if(name.startsWith('acl.'))assert.equal(new Set(rows.map(r=>r.kind+'.'+r.name)).size,rows.length,'Duplicate ACL entry')
 return{rowCount:result.rowCount,requestedIds:[...ids].sort(),rows,digest:hash(canonical(rows))}
}
function rowSet(p:Payload,ids:string[]){return p.rowCount===ids.length&&p.rows.length===ids.length&&new Set(p.rows.map(r=>r.id)).size===ids.length&&ids.every(id=>p.rows.some(r=>r.id===id))}
function completeScope(p:Payload|undefined,kind:string){
 if(!p||p.rowCount!==p.rows.length)return false
 const actual=p.rows.map(r=>kind==='fingerprints'?r.table:r.kind+'.'+r.name).sort()
 const expected=kind==='fingerprints'?[...tables].sort():verificationScope.acl.map(r=>r.kind+'.'+r.name).sort()
 return canonical(actual)===canonical(expected)
}
function assess(records:RecordEvent[],bindings:Binding[]){
 const all=(n:string)=>records.filter(r=>r.name===n).map(r=>r.data as Payload)
 const unique=(n:string)=>all(n).length===1?all(n)[0]:undefined
 const runs=bindings.map(b=>b.runId),tokens=bindings.map(b=>b.newTokenId)
 const original=unique('lease.original'),refreshed=unique('lease.refreshed'),restored=unique('lease.restored'),final=unique('tokens.final')
 const mutations=(n:string,ids:string[])=>all(n).length===ids.length&&ids.every(id=>all(n).filter(p=>canonical(p.requestedIds)===canonical([id])&&rowSet(p,[id])).length===1)
 const leaseSnapshots=Boolean(original&&refreshed&&restored&&[original,refreshed,restored].every(p=>rowSet(p!,runs)))
 const leasesRestored=leaseSnapshots&&runs.every(id=>{
  const old=original!.rows.find(r=>r.id===id),fresh=refreshed!.rows.find(r=>r.id===id),last=restored!.rows.find(r=>r.id===id)
  return canonical(old)===canonical(last)&&all('lease.refresh').some(p=>p.rows.some(r=>canonical(r)===canonical(fresh)))&&all('lease.restore').some(p=>p.rows.some(r=>canonical(r)===canonical(last)))
 })
 const tokenRevocation=Boolean(final&&rowSet(final,tokens)&&final.rows.every(r=>r.revoked===true&&typeof r.revokedExact==='string')&&tokens.every(id=>all('token.revoke').some(p=>p.rows.some(r=>r.id===id&&canonical(r)===canonical(final.rows.find(f=>f.id===id))))))
 const digestEqual=(kind:string)=>{
  const before=unique(kind+'.baseline'),after=unique(kind+'.final')
  return Boolean(before&&after&&completeScope(before,kind)&&completeScope(after,kind)&&before.digest===after.digest)
 }
 const baselineNames=['lease.original','fingerprints.baseline','acl.baseline'],firstMutation=records.find(r=>['lease.refresh','token.insert'].includes(r.name))?.sequence??-1
 const baselineBeforeMutations=baselineNames.every(n=>records.filter(r=>r.name===n).length===1&&records.find(r=>r.name===n)!.sequence<firstMutation)
 const checks={leaseSnapshots,leasesRestored,baselineBeforeMutations,leaseUpdateCounts:mutations('lease.refresh',runs)&&mutations('lease.restore',runs),tokenInsertCounts:mutations('token.insert',tokens),tokenRevokeCounts:mutations('token.revoke',tokens),tokenRevocation,protectedFingerprintsEqual:digestEqual('fingerprints'),aclEqual:digestEqual('acl'),noQueryErrors:!records.some(r=>r.name==='query.error')}
 return{checks,passed:Object.values(checks).every(Boolean)}
}
/** Recompute from retained projected rows. No database/revocation query is run. */
export function verifyEvidence(records:RecordEvent[],bindings:Binding[],expected:Expected){
 bindingsValid(bindings);assert.ok(records.length>=2&&records.length<=128);assert.equal(records[0].name,'start');assert.equal(records.at(-1)?.name,'finish')
 assert.equal(records.filter(r=>r.name==='start').length,1);assert.equal(records.filter(r=>r.name==='finish').length,1)
 let previous='0'.repeat(64)
 for(const [index,event]of records.entries()){
  assert.deepEqual(Object.keys(event).sort(),['sequence','at','name','data','previousSHA','sha256'].sort())
  const {sha256,...data}=event;assert.equal(event.sequence,index);assert.equal(event.previousSHA,previous);assert.equal(hash(canonical(data)),sha256,'Evidence hash mismatch');previous=sha256
  assert.ok(['start','finish','query.error',...names].includes(event.name));assert.equal(new Date(event.at).toISOString(),event.at)
  if(names.includes(event.name as Name)){
   const p=event.data as Payload;assert.equal(p.digest,hash(canonical(p.rows)));assert.ok(p.rows.length<=200)
   assert.deepEqual(Object.keys(p).sort(),['rowCount','requestedIds','rows','digest'].sort())
   if(event.name.startsWith('acl.')){
    assert.ok(p.rowCount===null||Number.isSafeInteger(p.rowCount)&&p.rowCount!>=0);assert.deepEqual(p.requestedIds,[])
    const fake=p.rows.map(row=>{assert.match(String(row.descriptorSHA),/^[a-f0-9]{64}$/);return{kind:row.kind,name:row.name,descriptor:'offline-identity-validation'}})
    const normalized=project(event.name as Name,{rowCount:p.rowCount,rows:fake},[],bindings)
    assert.deepEqual(p.rows.map(row=>Object.keys(row).sort()),normalized.rows.map(row=>Object.keys(row).sort()))
    assert.equal(canonical(p.rows),canonical([...p.rows].sort((a,b)=>canonical(a).localeCompare(canonical(b)))))
   }else{
    const rows=event.name.startsWith('fingerprints.')?p.rows.map(row=>({table_name:row.table,count:row.count,digest:row.digest})):p.rows
    assert.equal(canonical(project(event.name as Name,{rowCount:p.rowCount,rows},p.requestedIds,bindings)),canonical(p),'Unexpected evidence projection')
   }
  }
  if(event.name==='query.error'){
   assert.ok(names.includes(event.data.operation));assert.ok(event.data.sqlState===null||typeof event.data.sqlState==='string'&&/^[A-Z0-9]{5}$/.test(event.data.sqlState));assert.deepEqual(Object.keys(event.data).sort(),['operation','sqlState'])
  }
 }
 const header=records[0].data;assert.deepEqual(header.bindings,bindings);assert.equal(header.version,1);assert.equal(header.historicalResults,false);assert.match(header.sourceSHA,/^[a-f0-9]{40}$/);assert.match(header.manifestSHA,/^[a-f0-9]{64}$/);assert.ok(uuid(header.roundId))
 assert.deepEqual(Object.keys(header).sort(),['version','sourceSHA','manifestSHA','roundId','bindings','historicalResults'].sort())
 assert.equal(header.sourceSHA,expected.sourceSHA);assert.equal(header.manifestSHA,expected.manifestSHA);assert.equal(header.roundId,expected.roundId);assert.match(expected.lastSHA,/^[a-f0-9]{64}$/);assert.equal(records.at(-1)!.sha256,expected.lastSHA,'Final evidence anchor mismatch')
 const result=assess(records.slice(0,-1),bindings);assert.deepEqual(records.at(-1)!.data,result)
 return result
}
/** Exclusive, private append-only journal. Each append rejects path replacement. */
export class VerificationJournal{
 private records:RecordEvent[]=[]
 private identity:{dev:number;ino:number}
 private source:{sourceSHA:string;manifestSHA:string;roundId:string}
 readonly file:string
 constructor(directory:string,private bindings:Binding[],source:{sourceSHA:string;manifestSHA:string;roundId:string}){
  bindingsValid(bindings);assert.match(source.sourceSHA,/^[a-f0-9]{40}$/);assert.match(source.manifestSHA,/^[a-f0-9]{64}$/);assert.ok(uuid(source.roundId))
  this.bindings=bindings.map(b=>({runId:b.runId,newTokenId:b.newTokenId}));this.source={sourceSHA:source.sourceSHA,manifestSHA:source.manifestSHA,roundId:source.roundId}
  const dir=lstatSync(directory);assert.ok(dir.isDirectory()&&!dir.isSymbolicLink()&&(dir.mode&0o077)===0&&dir.uid===process.getuid!());assert.equal(realpathSync(directory),directory)
  this.file=join(directory,'verification.jsonl');const fd=openSync(this.file,'wx',0o600)
  try{const s=fstatSync(fd);this.identity={dev:s.dev,ino:s.ino}}finally{closeSync(fd)}
  this.append('start',{version:1,sourceSHA:source.sourceSHA,manifestSHA:source.manifestSHA,roundId:source.roundId,bindings:bindings.map(b=>({runId:b.runId,newTokenId:b.newTokenId})),historicalResults:false})
 }
 private append(name:RecordEvent['name'],data:any){
  assert.notEqual(this.records.at(-1)?.name,'finish','Evidence already finalized')
  const record={sequence:this.records.length,at:new Date().toISOString(),name,data,previousSHA:this.records.at(-1)?.sha256??'0'.repeat(64)},event={...record,sha256:hash(canonical(record))}
  const fd=openSync(this.file,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW)
  try{
   const s=fstatSync(fd);assert.ok(s.isFile()&&s.dev===this.identity.dev&&s.ino===this.identity.ino&&(s.mode&0o077)===0&&s.uid===process.getuid!(),'Evidence file changed')
   const data=Buffer.from(JSON.stringify(event)+'\n');assert.equal(writeSync(fd,data),data.length,'Incomplete evidence write')
  }finally{closeSync(fd)}
  this.records.push(event)
 }
 capture(name:Name,result:Result,ids:string[]=[]){const payload=project(name,result,ids,this.bindings);this.append(name,payload);return payload}
 baselineReady(){
  const get=(name:string)=>this.records.filter(r=>r.name===name)
  return get('lease.original').length===1&&rowSet(get('lease.original')[0].data,this.bindings.map(b=>b.runId))&&get('fingerprints.baseline').length===1&&completeScope(get('fingerprints.baseline')[0].data,'fingerprints')&&get('acl.baseline').length===1&&completeScope(get('acl.baseline')[0].data,'acl')&&!this.records.some(r=>['query.error','lease.refresh','token.insert'].includes(r.name))
 }
 queryError(operation:Name,error:unknown){
  assert.ok(names.includes(operation));const code=(error as {code?:unknown}|null)?.code
  this.append('query.error',{operation,sqlState:typeof code==='string'&&/^[A-Z0-9]{5}$/.test(code)?code:null}) // never message/config/query/secret fields
 }
 finish(){
  const result=assess(this.records,this.bindings);this.append('finish',result)
  const persisted=readFileSync(this.file,'utf8'),lastSHA=this.records.at(-1)!.sha256
  const verified=verifyEvidence(persisted.trimEnd().split('\n').map(s=>JSON.parse(s)),this.bindings,{...this.source,lastSHA})
  return{...verified,file:'verification.jsonl',records:this.records.length,lastSHA,fileSHA:hash(persisted),complete:true}
 }
}
