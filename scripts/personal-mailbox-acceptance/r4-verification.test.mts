import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { VerificationJournal,verifyEvidence,verificationScope } from './r4-verification.mjs'
const id=(n:number)=>`28740000-0000-4000-8000-${String(n).padStart(12,'0')}`
const bindings=[{runId:id(41),newTokenId:id(141)},{runId:id(42),newTokenId:id(142)}]
const old='2026-10-28T11:37:03.606107Z',fresh='2026-10-28T13:17:03.123456Z',revoked='2026-10-28T13:02:36.765432Z'
const meta={sourceSHA:'a'.repeat(40),manifestSHA:'b'.repeat(64),roundId:id(3)}
const result=(rows:any[],rowCount=rows.length)=>({rowCount,rows})
function make(){const directory=fs.mkdtempSync(join(tmpdir(),'mikka-evidence-only-'));return{directory,journal:new VerificationJournal(directory,bindings,meta)}}
function fill(j:VerificationJournal,options:{missingToken?:boolean;wrongLease?:boolean;missingRevoke?:boolean;duplicateInsert?:boolean;changedDigest?:boolean;incompleteScope?:boolean}={}){
 const leases=(value:string)=>result(bindings.map(b=>({id:b.runId,leaseExact:value,privateBody:'must not persist'})))
 j.capture('lease.original',leases(old),bindings.map(b=>b.runId))
 const digests=(phase:'baseline'|'final')=>{
  j.capture(`fingerprints.${phase}`,result((options.incompleteScope?verificationScope.tables.slice(0,1):verificationScope.tables).map(table_name=>({table_name,count:table_name==='run_tokens'?2:0,digest:table_name==='run_tokens'?(options.changedDigest&&phase==='final'?'c'.repeat(64):'d'.repeat(64)):createHash('sha256').update('').digest('hex'),privateRows:'never copy'}))))
  j.capture(`acl.${phase}`,result((options.incompleteScope?verificationScope.acl.slice(0,1):verificationScope.acl).map(row=>({...row,descriptor:'never copy raw descriptor',secret:'must not persist'}))))
 }
 digests('baseline');assert.equal(j.baselineReady(),!options.incompleteScope)
 for(const b of bindings){
  j.capture('lease.refresh',result([{id:b.runId,leaseExact:fresh}]),[b.runId])
  const insert=result([{id:b.newTokenId,runId:b.runId,tokenHash:'f'.repeat(64),password:'must not persist'}]);j.capture('token.insert',insert,[b.newTokenId])
  if(options.duplicateInsert)j.capture('token.insert',insert,[b.newTokenId])
 }
 j.capture('lease.refreshed',leases(fresh),bindings.map(b=>b.runId))
 for(const b of bindings){
  const rows=[{id:b.newTokenId,runId:b.runId,revoked:true,revokedExact:revoked,tokenHash:'f'.repeat(64)}]
  j.capture('token.revoke',result(options.missingRevoke?[]:rows),[b.newTokenId])
  j.capture('lease.restore',result([{id:b.runId,leaseExact:options.wrongLease?'2026-10-28T11:37:03.606000Z':old}]),[b.runId])
 }
 j.capture('lease.restored',leases(options.wrongLease?'2026-10-28T11:37:03.606000Z':old),bindings.map(b=>b.runId))
 j.capture('tokens.final',result((options.missingToken?bindings.slice(1):bindings).map(b=>({id:b.newTokenId,runId:b.runId,revoked:true,revokedExact:revoked}))),bindings.map(b=>b.newTokenId))
 digests('final')
}
const read=(file:string)=>fs.readFileSync(file,'utf8').trim().split('\n').map(s=>JSON.parse(s))
test('complete projected SQL returns independently recompute counts, exact microseconds, digests and every cleanup check',()=>{
 const {journal}=make();fill(journal);const done=journal.finish(),records=read(journal.file)
 assert.equal(done.passed,true);assert.equal(verifyEvidence(records,bindings,{...meta,lastSHA:done.lastSHA}).passed,true)
 const lease=records.find(r=>r.name==='lease.restored').data.rows[0];assert.equal(lease.leaseExact,old);assert.equal(lease.leaseSHA.length,64)
 const tokens=records.find(r=>r.name==='tokens.final').data;assert.equal(tokens.rowCount,2);assert.equal(tokens.rows[0].revokedExact,revoked)
 const text=fs.readFileSync(journal.file,'utf8');for(const privateText of ['must not persist','never copy raw descriptor','never copy','f'.repeat(64),'privateBody','tokenHash','password','privateRows'])assert.equal(text.includes(privateText),false)
 assert.equal(fs.statSync(journal.file).mode&0o077,0)
})
for(const options of [{missingToken:true},{missingRevoke:true},{wrongLease:true},{duplicateInsert:true},{changedDigest:true},{incompleteScope:true}])test('incomplete or mismatched SQL proof never passes '+JSON.stringify(options),()=>{
 const {journal}=make();fill(journal,options);const done=journal.finish();assert.equal(done.passed,false);assert.equal(verifyEvidence(read(journal.file),bindings,{...meta,lastSHA:done.lastSHA}).passed,false)
})
test('empty returned token set is not vacuous revocation success; partial evidence/footer cannot be a pass',()=>{
 const {journal}=make();journal.capture('tokens.final',result([]),bindings.map(b=>b.newTokenId));const done=journal.finish();assert.equal(done.passed,false)
 const records=read(journal.file);assert.throws(()=>verifyEvidence(records.slice(0,-1),bindings,{...meta,lastSHA:done.lastSHA}));records[1].data.rowCount=2;assert.throws(()=>verifyEvidence(records,bindings,{...meta,lastSHA:done.lastSHA}),/hash mismatch/)
})
test('query failures capture SQLSTATE only, never error message/config/SQL/source secrets',()=>{
 const {journal}=make();fill(journal);journal.queryError('token.revoke',{code:'57014',message:'mkw_'+'x'.repeat(43),password:'private',query:'secret SQL'});const done=journal.finish();assert.equal(done.passed,false)
 const records=read(journal.file),error=records.find(r=>r.name==='query.error');assert.deepEqual(error.data,{operation:'token.revoke',sqlState:'57014'})
 assert.equal(fs.readFileSync(journal.file,'utf8').includes('mkw_'),false);assert.equal(verifyEvidence(records,bindings,{...meta,lastSHA:done.lastSHA}).passed,false)
})
test('foreign binding and malformed/rounded timestamp results are rejected without writing their contents',()=>{
 const {journal}=make(),before=fs.readFileSync(journal.file,'utf8')
 assert.throws(()=>journal.capture('token.insert',result([{id:id(999),runId:bindings[0].runId}]),[bindings[0].newTokenId]))
 for(const value of ['2026-10-28T11:37:03.606Z','2026-02-30T11:37:03.606107Z','mkw_'+'x'.repeat(43)])assert.throws(()=>journal.capture('lease.original',result([{id:bindings[0].runId,leaseExact:value}]),[bindings[0].runId]))
 assert.equal(fs.readFileSync(journal.file,'utf8'),before)
})
test('existing evidence cannot be overwritten; inode replacement and append after finish fail closed',()=>{
 const {directory,journal}=make();assert.throws(()=>new VerificationJournal(directory,bindings,meta),/EEXIST/)
 fs.renameSync(journal.file,join(directory,'retained-original.jsonl'));fs.writeFileSync(journal.file,'replacement',{mode:0o600})
 assert.throws(()=>journal.capture('tokens.final',result([])),/Evidence file changed/);assert.equal(fs.readFileSync(journal.file,'utf8'),'replacement')
 const second=make();second.journal.finish();assert.throws(()=>second.journal.finish(),/already finalized/)
})
test('finish independently reads persisted bytes, refusing a truncated file rather than trusting memory',()=>{
 const {journal}=make();fill(journal);const original=fs.readFileSync(journal.file,'utf8');fs.writeFileSync(journal.file,original.split('\n')[0]+'\n')
 assert.throws(()=>journal.finish())
})
test('header fields are projected and verifier binds independently supplied metadata and final receipt anchor',()=>{
 const directory=fs.mkdtempSync(join(tmpdir(),'mikka-evidence-only-')),journal=new VerificationJournal(directory,bindings,{...meta,password:'must-not-log',token:'mkw_'+'x'.repeat(43)} as any)
 fill(journal);const done=journal.finish(),records=read(journal.file)
 assert.equal(fs.readFileSync(journal.file,'utf8').includes('must-not-log'),false);assert.equal(fs.readFileSync(journal.file,'utf8').includes('mkw_'),false)
 for(const changed of [{sourceSHA:'c'.repeat(40)},{manifestSHA:'d'.repeat(64)},{roundId:id(9)},{lastSHA:'0'.repeat(64)}])assert.throws(()=>verifyEvidence(records,bindings,{...meta,lastSHA:done.lastSHA,...changed}))
})
test('even a recomputed outer chain cannot bless forged inner timestamp hash, token binding or extra row fields',()=>{
 const canonical=(v:any):string=>JSON.stringify(v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])))
 const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
 const {journal}=make();fill(journal);journal.finish()
 for(const mutate of [(records:any[])=>{records.find(r=>r.name==='lease.restored').data.rows[0].leaseSHA='0'.repeat(64)},(records:any[])=>{records.find(r=>r.name==='token.insert').data.rows[0].runId=id(999)},(records:any[])=>{records.find(r=>r.name==='acl.final').data.rows[0].password='must-not-bless'}]){
  const records=read(journal.file);mutate(records);let previous='0'.repeat(64)
  for(const record of records){if(record.data.rows)record.data.digest=hash(canonical(record.data.rows));record.previousSHA=previous;const {sha256,...body}=record;assert.ok(sha256);record.sha256=hash(canonical(body));previous=record.sha256}
  assert.throws(()=>verifyEvidence(records,bindings,{...meta,lastSHA:previous}))
 }
})
