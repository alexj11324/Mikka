import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
const here=dirname(fileURLToPath(import.meta.url)),driver=resolve('driver-source'),out=resolve('group-cleanup-report')
const m=JSON.parse(readFileSync(join(here,'manifest.json'),'utf8'))
assert.deepEqual(m.cases.map(x=>x.key),['public-haiku','public-luna','private-haiku'])
const rows=[];mkdirSync(out,{recursive:true})
for(const c of m.cases){
 const child=spawnSync(process.execPath,['scripts/acceptance/issue-1506-alex/group-stop.mjs','cleanup',join(here,c.file)],{cwd:driver,encoding:'utf8',timeout:220000,maxBuffer:1024*1024,env:process.env})
 writeFileSync(join(out,c.key+'.stdout'),child.stdout??'');writeFileSync(join(out,c.key+'.stderr'),child.stderr??'')
 let verified=false,error=null
 try{
  const key=c.key.endsWith('haiku')?'haiku':'luna',boundary=c.key.startsWith('private')?'private_generation_receipt':'responding_bot'
  const r=JSON.parse(readFileSync(join(driver,'issue-1506-alex-report','group-stop-'+key+'-'+boundary+'-f1324daf-cleanup.json'),'utf8'))
  assert.equal(child.status,0);assert.equal(r.groupId,c.groupId);assert.equal(r.messageId,c.messageId)
  assert.equal(r.mode,'cleanup');assert.equal(r.status,'cleanup_complete');assert.equal(r.cleanup.status,'complete')
  assert.equal(r.cleanup.hidden,true);assert.equal(r.signedOut,true);assert.equal(r.afterStop.active,false)
  const original=JSON.parse(readFileSync(join(here,c.file),'utf8'))
  assert.deepEqual([...r.cleanup.removedBotIds].sort(),[...original.cleanup.retainedBotIds].sort())
  const removed=r.requests.filter(x=>x.method==='DELETE'&&x.path==='/mikka/api/conversations/'+c.groupId+'/members'&&x.status>=200&&x.status<300)
  assert.equal(removed.length,original.cleanup.retainedBotIds.length)
  assert.equal(r.requests.some(x=>x.method==='POST'&&(x.path==='/mikka/api/conversations'||x.path.endsWith('/messages'))),false)
  assert.equal(r.requests.some(x=>x.method==='DELETE'&&x.path!=='/mikka/api/conversations/'+c.groupId+'/members'),false)
  verified=true
 }catch{error='cleanup_receipt_not_complete'}
 rows.push({case:c.key,exitCode:child.status,signal:child.signal,verified,error,automaticRetry:false})
 writeFileSync(join(out,'summary.json'),JSON.stringify({schemaVersion:1,issue:1506,mode:'group-only-cleanup',sourceSha:m.sourceSha,cases:rows,allCompleted:rows.length===3&&rows.every(x=>x.verified),modelSends:0,workspaceDeletion:false,botDeletion:false},null,2)+'\n')
}
if(rows.some(x=>!x.verified))process.exitCode=1
