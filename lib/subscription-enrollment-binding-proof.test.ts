import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { enrollmentBindingDatabaseIdentity, enrollmentBindingPage, mintEnrollmentBindingProof, verifyEnrollmentBindingProof } from './subscription-enrollment-binding-proof'
import { enrollmentBindHTTP } from './subscription-enrollment-bind'
const key = 'fixture-control-key-with-sufficient-entropy-123456'
const target = { id: '46786d33-159b-4236-880b-951742e98d3e', ownerId: 'real-mikka-owner', workspaceId: '10000000-0000-4000-8000-000000000001', origin: 'https://mikka.example', databaseIdentity: 'a'.repeat(64) }
const now = 1800000000000

test('short scoped proof accepts exact target and rejects scope changes or another operator', () => {
  const proof = mintEnrollmentBindingProof(key, target, now)
  assert.equal(verifyEnrollmentBindingProof(key, proof, target, now), true)
  assert.equal(verifyEnrollmentBindingProof(key + '-other', proof, target, now), false)
  for (const [field, value] of Object.entries({id:'20000000-0000-4000-8000-000000000002',ownerId:'other-owner',workspaceId:'20000000-0000-4000-8000-000000000002',origin:'https://other.example',databaseIdentity:'b'.repeat(64)})) assert.equal(verifyEnrollmentBindingProof(key, proof, {...target,[field]:value}, now), false)
  for (const malformed of [proof+'x','x.'+proof.split('.')[1],proof+'.extra','', 'x'.repeat(2049)]) assert.equal(verifyEnrollmentBindingProof(key, malformed, target, now), false)
})
test('proof expires and refuses an expiry over five minutes or weak/invalid issuance', () => {
  const proof=mintEnrollmentBindingProof(key,target,now)
  assert.equal(verifyEnrollmentBindingProof(key,proof,target,now+300000),false)
  assert.equal(verifyEnrollmentBindingProof(key,proof,target,now-1),false)
  for(const lifetime of [0,300001,Infinity]) assert.throws(()=>mintEnrollmentBindingProof(key,target,now,lifetime))
  assert.throws(()=>mintEnrollmentBindingProof('weak',target,now))
  for(const origin of ['https://mikka.example/path','https://user:password@mikka.example','http://mikka.example']) assert.throws(()=>mintEnrollmentBindingProof(key,{...target,origin},now))
})
test('database identity matches Go canonical pooler/direct identity without credential or query dependence', () => {
  const expected=createHash('sha256').update('db.example:5432/mikka').digest('hex')
  assert.equal(enrollmentBindingDatabaseIdentity('postgresql://fixture:fixture@db-pooler.example/mikka?sslmode=require'),expected)
  assert.equal(enrollmentBindingDatabaseIdentity('postgresql://other:other@db.example:5432/mikka'),expected)
  assert.notEqual(enrollmentBindingDatabaseIdentity('postgresql://fixture:fixture@db.example/other'),expected)
})
test('scoped route still requires real session, derives principal server-side and retains workspace checks', async () => {
  let session: {userId:string}|null=null, allowed=true
  const calls:unknown[]=[]
  const route=enrollmentBindHTTP({operator:async()=>null,session:async()=>session,handoff:async(request,ownerId,body)=>body.proof&&verifyEnrollmentBindingProof(key,body.proof,{...target,id:body.id,workspaceId:body.workspaceId,ownerId,origin:new URL(request.url).origin})?'operator:server-derived':null,workspace:async(owner,wsp)=>{calls.push(['workspace',owner,wsp]);if(!allowed)throw Error('denied')},client:()=>({bind:async(...args)=>{calls.push(['bind',...args]);return {id:target.id}}})})
  const proof=mintEnrollmentBindingProof(key,target)
  const post=(body:unknown,origin=target.origin)=>route(new Request(target.origin+'/bind',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}))
  const body={id:target.id,workspaceId:target.workspaceId,proof}
  assert.equal((await post(body)).status,401);assert.equal(calls.length,0)
  session={userId:'other-owner'};assert.equal((await post(body)).status,401);assert.equal(calls.length,0)
  session={userId:target.ownerId};assert.equal((await post({...body,ownerId:target.ownerId})).status,401)
  assert.equal((await post(body,'https://foreign.example')).status,403)
  allowed=false;assert.equal((await post(body)).status,409);assert.equal(calls.length,1)
  allowed=true;calls.length=0;assert.equal((await post(body)).status,200)
  assert.deepEqual(calls,[['workspace',target.ownerId,target.workspaceId],['bind','operator:server-derived',target.id,target.ownerId,target.workspaceId]])
})
test('binding HTML has no supplied secret, scrubs fragment and restricts transport to same origin', async()=>{
  const response=enrollmentBindingPage(),html=await response.text()
  assert.equal(response.headers.get('cache-control'),'private, no-store')
  assert.equal(response.headers.get('referrer-policy'),'no-referrer')
  assert.match(response.headers.get('content-security-policy')!,/connect-src 'self'/)
  assert.match(response.headers.get('content-security-policy')!,/script-src 'sha256-/)
  assert.ok(html.indexOf('history.replaceState')<html.indexOf('fetch('))
  assert.doesNotMatch(html,/localStorage|sessionStorage|Authorization|location\.replace|operator-key/)
})

test('preflighted binding page handles later fragment navigation and scrubs it before same-origin POST', async()=>{
  const { Window }=await import('happy-dom')
  const window=new Window({url:target.origin+'/bind'})
  const calls:{url:string;body:unknown}[]=[]
  window.fetch=(async(url:unknown,options:{body?:string})=>{calls.push({url:String(url),body:JSON.parse(options.body!)});return new window.Response('{}',{status:200})}) as typeof window.fetch
  try{
    const html=await enrollmentBindingPage().text(),script=html.match(/<script>([\s\S]*?)<\/script>/)![1]
    window.eval(script)
    assert.equal(calls.length,0)
    const proof=mintEnrollmentBindingProof(key,target)
    window.location.hash=new URLSearchParams({id:target.id,workspaceId:target.workspaceId,proof}).toString()
    for(let i=0;i<100&&calls.length===0;i++) await new Promise(resolve=>setTimeout(resolve,5))
    for(let i=0;i<100&&!window.document.body.textContent.includes('Subscription bound');i++) await new Promise(resolve=>setTimeout(resolve,5))
    assert.deepEqual(calls,[{url:'/bind',body:{id:target.id,workspaceId:target.workspaceId,proof}}])
    assert.equal(window.location.hash,'')
    assert.ok(window.document.body.textContent.includes('Subscription bound'))
  }finally{await window.happyDOM.close()}
})
