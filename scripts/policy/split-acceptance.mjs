// Actual loopback HTTP + PostgreSQL; no provider requests or Docker orchestration.
import assert from 'node:assert/strict'
import {randomUUID,randomBytes} from 'node:crypto'
import {writeFile,mkdir} from 'node:fs/promises'
import {Pool} from 'pg'
import {PolicyStore} from '../../lib/policy/store.ts'
import {policySigner} from '../../lib/policy/signing.ts'
import {getMigrations} from 'better-auth/db/migration'
import {betterAuth} from 'better-auth'
import {oauthProvider} from '@better-auth/oauth-provider'
const coreOrigin=new URL(process.env.POLICY_CORE_ORIGIN??'http://127.0.0.1:3130')
const enterpriseOrigin=process.env.POLICY_ENTERPRISE_ORIGIN?new URL(process.env.POLICY_ENTERPRISE_ORIGIN):null
for(const url of [coreOrigin,...(enterpriseOrigin?[enterpriseOrigin]:[])]){assert.equal(url.hostname,'127.0.0.1');assert.equal(url.protocol,'http:')}
for(const name of ['MIKKA_DATABASE_URL','DATABASE_URL']){const url=new URL(process.env[name]);assert.equal(url.hostname,'127.0.0.1');assert.ok(url.pathname.endsWith('_e2e'))}
assert.notEqual(process.env.MIKKA_DATABASE_URL,process.env.DATABASE_URL)
assert.ok(process.env.BETTER_AUTH_SECRET?.length>=32,'synthetic runtime signing secret required')
const app=new Pool({connectionString:process.env.MIKKA_DATABASE_URL}),ws=new Pool({connectionString:process.env.DATABASE_URL})
const store=new PolicyStore(ws,policySigner(process.env.BETTER_AUTH_SECRET))
const results=[],requests=[]
function client(){const jar=new Map();return {jar,async call(origin,path,method='GET',body){const headers={};if(jar.size)headers.cookie=[...jar].map(([k,v])=>`${k}=${v}`).join('; ');if(body!==undefined){headers['content-type']='application/json';headers.origin=origin.origin}const r=await fetch(new URL('/mikka'+path,origin),{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});for(const cookie of r.headers.getSetCookie()){const [pair]=cookie.split(';');const at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1))}const data=await r.json();requests.push({method,path,status:r.status});return {status:r.status,body:data}}}}
const owner=client(),other=client();const origin=enterpriseOrigin??coreOrigin
const w=randomUUID(),foreign=randomUUID();const path=id=>`/api/policy?workspaceId=${id}`
const document=(id,state='enforce')=>({schemaVersion:1,state,offlineTtlSeconds:60,layers:[{scope:'workspace',id,ceiling:{git_push:'deny'},models:[]}]})
try{
 for(const endpoint of [coreOrigin,...(enterpriseOrigin?[enterpriseOrigin]:[])]){let ready=false;for(let i=0;i<60;i++){try{await fetch(new URL('/mikka/api/policy',endpoint));ready=true;break}catch{await new Promise(resolve=>setTimeout(resolve,500))}}assert.ok(ready,'compiled runtime did not become ready')}
 const migration=await getMigrations({database:app,emailAndPassword:{enabled:true},plugins:[oauthProvider({loginPage:'/sign-in',consentPage:'/oauth/consent',disableJwtPlugin:true})]});await migration.runMigrations()
 // Provision only synthetic identities with real Better Auth + PostgreSQL.
 // Email delivery is outside this policy test; no production session is forged.
 const fixtureAuth=betterAuth({database:app,secret:process.env.BETTER_AUTH_SECRET,baseURL:origin.origin,basePath:'/mikka/api/auth',emailAndPassword:{enabled:true}})
 async function signup(c){const r=await fixtureAuth.api.signUpEmail({body:{name:'Synthetic split acceptance',email:`split-${randomUUID()}@example.invalid`,password:randomBytes(32).toString('base64url')},asResponse:true});assert.equal(r.status,200);for(const cookie of r.headers.getSetCookie()){const [pair]=cookie.split(';');const at=pair.indexOf('=');c.jar.set(pair.slice(0,at),pair.slice(at+1))}return (await r.json()).user.id}
 const ownerId=await signup(owner),otherId=await signup(other)
 await ws.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Synthetic split A'),($3,$4,'Synthetic split B')`,[w,ownerId,foreign,otherId])
 await ws.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,'Synthetic','a@example.invalid','admin'),($3,$4,'Synthetic','b@example.invalid','admin')`,[w,ownerId,foreign,otherId])
 if(enterpriseOrigin){
  const denied=await other.call(origin,path(w),'POST',{expectedVersion:0,document:document(w)});assert.equal(denied.status,403);results.push('foreign owner publication denied')
  assert.equal((await other.call(origin,path(w))).status,403);results.push('foreign owner historical/current read denied')
  const published=await owner.call(origin,path(w),'POST',{expectedVersion:0,document:document(w)});assert.equal(published.status,201);assert.equal(published.body.payload.version,1)
  assert.equal((await store.read(w,ownerId)).payload.version,1);results.push('enterprise publication persisted by public PolicyStore')
  assert.equal((await owner.call(origin,path(w),'POST',{expectedVersion:0,document:document(w)})).status,409);results.push('stale expectedVersion rejected')
  const contenders=await Promise.all(Array.from({length:8},()=>owner.call(origin,path(w),'POST',{expectedVersion:1,document:document(w)})))
  assert.equal(contenders.filter(r=>r.status===201).length,1);assert.equal(contenders.filter(r=>r.status===409).length,7);results.push('8 concurrent publications have one CAS winner')
  const rolled=await owner.call(origin,path(w),'POST',{expectedVersion:2,rollbackOf:1});assert.equal(rolled.status,201);assert.equal(rolled.body.payload.version,3);assert.equal((await store.read(w,ownerId)).payload.version,3);results.push('enterprise rollback persisted as new core version')
 }else{await store.publish(w,ownerId,0,document(w));results.push('core-only fixture policy enrolled through public PolicyStore')}
 const managementAbsent=await owner.call(coreOrigin,path(w));assert.equal(managementAbsent.status,503);assert.equal(managementAbsent.body.error,'policyManagementUnavailable');results.push('community management adapter absent')
 const before=await owner.call(coreOrigin,'/api/agent','POST',{prompt:'Synthetic denied operation; no provider may execute.'});assert.equal(before.body.error,'modelRouteDenied');results.push('existing enforced policy still denies execution without enterprise adapter')
 const previous=(await store.read(w,ownerId)).payload.version
 if(enterpriseOrigin){const r=await owner.call(origin,path(w),'POST',{expectedVersion:previous,document:document(w,'revoked')});assert.equal(r.status,201)}else await store.publish(w,ownerId,previous,document(w,'revoked'))
 const revoked=await owner.call(coreOrigin,'/api/agent','POST',{prompt:'Synthetic revoked operation; no provider may execute.'});assert.equal(revoked.body.error,'policyRevoked');results.push('revocation remains enforced without enterprise adapter')
 const audit=(await ws.query(`SELECT count(*)::int count FROM security_audit_events WHERE tenant=$1 AND event->>'action'='policy.published'`,[w])).rows[0].count
 assert.equal(audit,enterpriseOrigin?4:2);results.push('publication count matches durable audit count')
 const databases=[];for(const pool of [app,ws])databases.push((await pool.query('SELECT current_database() database')).rows[0].database)
 const output={utc:new Date().toISOString(),mode:enterpriseOrigin?'enterprise-and-community':'community-only',results,requests,databases,auditEvents:audit,providerCalls:0,providerEvidence:'no provider credentials supplied; requests rejected by policy before provider invocation',production:false,syntheticEnrollment:'Real Better Auth library and PostgreSQL; email delivery and production login not tested'}
 const dir=process.env.POLICY_SPLIT_EVIDENCE_DIR??'/tmp/policy-split-evidence';await mkdir(dir,{recursive:true});await writeFile(dir+'/acceptance.json',JSON.stringify(output,null,2));console.log(JSON.stringify({mode:output.mode,checks:results.length,requests:requests.length,databases,auditEvents:audit}))
}finally{await app.end();await ws.end()}
