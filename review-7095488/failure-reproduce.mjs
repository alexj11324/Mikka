import assert from 'node:assert/strict'
import {Pool} from 'pg'
import {randomUUID,randomBytes,createHash} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
const origin='http://127.0.0.1:3110',output='/tmp/audit-210-http-7095488',sha=process.env.AUDIT_EXACT_SHA
const target=new URL(process.env.AUDIT_APP_TEST_URL)
assert.equal(target.hostname,'127.0.0.1');assert.ok(target.pathname.endsWith('_e2e'));assert.match(sha,/^[a-f0-9]{40}$/)
const pool=new Pool({connectionString:target.href}),jar=new Map(),requests=[]
const credentials={email:`failure-${randomUUID()}@example.invalid`,password:randomBytes(32).toString('base64url'),name:'Synthetic fault acceptance'}
async function call(path,body,extra={}) {
 const id=randomUUID(),headers={origin,'x-request-id':id,...extra}
 if(jar.size)headers.cookie=[...jar].map(([k,v])=>`${k}=${v}`).join('; ')
 const options={method:body===undefined?'GET':'POST',headers}
 if(body!==undefined){headers['content-type']='application/json';options.body=JSON.stringify(body)}
 const r=await fetch(origin+'/mikka'+path,options)
 for(const line of r.headers.getSetCookie()){const pair=line.split(';',1)[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1))}
 requests.push({id,path,status:r.status,utc:new Date().toISOString()})
 const text=await r.text();return {status:r.status,text,body:text&&r.headers.get('content-type')?.includes('application/json')?JSON.parse(text):null}
}
try{
 const signup=await call('/api/auth/sign-up/email',credentials);assert.equal(signup.status,200)
 const owner=signup.body.user.id,tenant=`personal:${owner}`
 assert.equal((await call('/api/audit',{operation:'policy',retentionDays:30,legalHold:false})).status,200)
 const sessions=(await pool.query('SELECT count(*) FROM session WHERE "userId"=$1',[owner])).rows[0].count
 await pool.query('ALTER TABLE security_audit_heads RENAME TO security_audit_heads_unavailable')
 try{
  const rejected=await call('/api/audit',{operation:'policy',retentionDays:1,legalHold:false})
  assert.equal(rejected.status,503);assert.equal(rejected.body.error,'auditUnavailable')
  // Keep the original browser jar; a rejected login cannot replace or issue a session.
  const login=await fetch(origin+'/mikka/api/auth/sign-in/email',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(credentials)})
  requests.push({id:randomUUID(),path:'/api/auth/sign-in/email',status:login.status,utc:new Date().toISOString()})
  assert.equal(login.status,503)
  assert.equal((await pool.query('SELECT count(*) FROM session WHERE "userId"=$1',[owner])).rows[0].count,sessions)
 }finally{await pool.query('ALTER TABLE security_audit_heads_unavailable RENAME TO security_audit_heads')}
 assert.equal((await pool.query('SELECT retention_days FROM security_audit_heads WHERE tenant=$1',[tenant])).rows[0].retention_days,30)
 assert.equal((await call('/api/audit',{operation:'verify'})).status,200)
 const exportId=randomUUID(),created=await call('/api/audit/export',{}, {'idempotency-key':exportId});assert.equal(created.status,200)
 const snapshot=created.body.snapshots.application
 const page1=await call(`/api/audit/export?id=${exportId}&source=application&after=${snapshot.lower_seq}&limit=1`)
 assert.equal(page1.status,200);const first=page1.text.trim().split('\n').map(v=>JSON.parse(v)),manifest=first.shift()
 assert.ok(manifest.next)
 execFileSync('docker',['restart','mikka-audit-210-app-7095488'],{stdio:'ignore'})
 let ready=false
 for(let n=0;n<80;n++){try{const r=await fetch(origin+'/mikka/api/audit');if(r.status===401){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,250))}
 assert.ok(ready)
 let after=manifest.next,count=1,last=first[0].hash
 do{
  const response=await call(`/api/audit/export?id=${exportId}&source=application&after=${after}&limit=1`);assert.equal(response.status,200)
  const lines=response.text.trim().split('\n').map(v=>JSON.parse(v)),meta=lines.shift()
  for(const row of lines){assert.equal(row.prev_hash,last);assert.equal(row.hash,createHash('sha256').update(last+'\n'+row.canonical).digest('hex'));last=row.hash;count++}
  after=meta.next
 }while(after)
 assert.equal(count,Number(snapshot.count));assert.equal(last,snapshot.end_hash)
 const original=(await pool.query('SELECT seq,hash FROM security_audit_events WHERE tenant=$1 ORDER BY seq LIMIT 1',[tenant])).rows[0]
 async function setHash(hash){const tx=await pool.connect();try{await tx.query('BEGIN');await tx.query('ALTER TABLE security_audit_events DISABLE TRIGGER security_audit_immutable');await tx.query('UPDATE security_audit_events SET hash=$3 WHERE tenant=$1 AND seq=$2',[tenant,original.seq,hash]);await tx.query('ALTER TABLE security_audit_events ENABLE TRIGGER security_audit_immutable');await tx.query('COMMIT')}catch(e){await tx.query('ROLLBACK');throw e}finally{tx.release()}}
 await setHash('controlled-corruption')
 try{const detection=await call('/api/audit',{operation:'verify'});assert.equal(detection.status,409);assert.equal(detection.body.error,'auditIntegrityViolation')}finally{await setHash(original.hash)}
 assert.equal((await call('/api/audit',{operation:'verify'})).status,200)
 await writeFile(output+'/failure-restart-acceptance.json',JSON.stringify({sha,origin,utc:new Date().toISOString(),layer:'actual compiled Next HTTP and isolated PG; synthetic fixture only',owner,tenant,exportId,expectedCount:snapshot.count,actualCount:count,verifiedHash:last,requests,status:'passed'},null,2))
 console.log(JSON.stringify({status:'passed',sha,requests:requests.length,count,exportId}))
}finally{await pool.end()}
