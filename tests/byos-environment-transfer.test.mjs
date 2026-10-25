// Actual authenticated handler + production custody binary + real isolated PG.
// TLS and CONNECT proxy are loopback fixtures; no external network or grant.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as httpsServer } from 'node:https'
import { createServer as httpServer } from 'node:http'
import { connect } from 'node:net'
import { Pool } from 'pg'
import { universalAuthTokenProvider } from '../lib/credentials/universal-auth.ts'
import { EnrollmentClient } from '../lib/subscription-enrollment.ts'
import { enrollmentBindHTTP } from '../lib/subscription-enrollment-bind.ts'
import { enrollmentBindingDatabaseIdentity } from '../lib/subscription-enrollment-binding-proof.ts'

test('authenticated transfer route carries separate leases through production worker and preserves source', { timeout: 30000 }, async () => {
 const databaseUrl=process.env.MIKKA_BYOS_TEST_DATABASE_URL
 assert.ok(databaseUrl && new URL(databaseUrl).hostname==='127.0.0.1' && new URL(databaseUrl).pathname.endsWith('_e2e'))
 const pool=new Pool({connectionString:databaseUrl,max:2})
 const dir=await mkdtemp(join(tmpdir(),'mikka-transfer-'))
 const cert=join(dir,'cert.pem'),key=join(dir,'key.pem')
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=app.infisical.com','-addext','subjectAltName=DNS:app.infisical.com','-addext','basicConstraints=critical,CA:TRUE'],{stdio:'ignore'})
 const id=randomUUID(),owner=`fixture-${randomUUID()}`,workspace=randomUUID(),principal='operator:'+'a'.repeat(64)
 const source=JSON.stringify({schema:'mikka.byos.unbound-grant.v1',principal,id,bindingState:'pending_unbound',provider:'claude',createdAt:new Date().toISOString(),payload:{type:'claude',access_token:'fixture-cross-env-access',refresh_token:'fixture-cross-env-refresh',expired:new Date(Date.now()+3600000).toISOString(),account_uuid:'fixture-account',organization_uuid:'fixture-org'}})
 const values=new Map([[`staging/byos/pending-grants/mikka-byos-${id}`,source],[`staging/byos/enrollment-claims/mikka-byos-${id}`,JSON.stringify({schema:'mikka.byos.claim.v1',principal,id})]])
 let deletes=0, destinationWrites=0, bindingClaimReads=0, denial=''
 const vault=httpsServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
  const u=new URL(req.url,'https://app.infisical.com');let body={}
  if(req.method!=='GET'){let raw='';for await(const c of req)raw+=c;body=JSON.parse(raw)}
  const env=req.method==='GET'?u.searchParams.get('environment'):body.environment
  const path=req.method==='GET'?u.searchParams.get('secretPath'):body.secretPath
  assert.equal(req.headers.authorization,`Bearer ${env==='staging'?'fixture-source-lease':'fixture-destination-lease'}`)
  const lookup=`${env}${path}/${u.pathname.split('/').at(-1)}`
  if(env==='staging' && path==='/byos/enrollment-claims') {
   const receipt=u.pathname.endsWith(`/mikka-byos-${id}`)
   if(req.method==='GET' && !receipt)bindingClaimReads++
   // Even an exact readable proof must not conceal a denied create.
   if(denial==='claim-create' && req.method==='POST')values.set(lookup,body.secretValue)
   if((denial==='receipt-get' && req.method==='GET' && receipt) ||
      (denial==='claim-create' && req.method==='POST') ||
      (['claim-read','existing-claim-get'].includes(denial) && req.method==='GET' && !receipt)) {res.writeHead(403).end();return}
   if(denial==='claim-read' && req.method==='POST'){res.writeHead(503).end();return}
  }
  if(req.method==='DELETE'){deletes++;res.writeHead(403).end();return}
  if(req.method==='POST'){
   assert.ok((env==='staging' && path==='/byos/enrollment-claims') || (env==='prod' && ['/byos/grants','/byos/access'].includes(path)))
   if(env==='prod')destinationWrites++
   if(values.has(lookup)){res.writeHead(409).end();return}values.set(lookup,body.secretValue)
  }else{assert.equal(req.method,'GET');assert.equal(u.searchParams.get('version'),'1')}
  if(!values.has(lookup)){res.writeHead(404).end();return}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({secret:{secretKey:u.pathname.split('/').at(-1),secretValue:values.get(lookup),version:1}}))
 })
 const proxy=httpServer((_,res)=>res.writeHead(403).end())
 const sockets=new Set()
 proxy.on('connect',(req,client,head)=>{
  if(req.url!=='app.infisical.com:443'){client.destroy();return}
  const upstream=connect(vault.address().port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client)})
  for(const s of [client,upstream]){sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{client.destroy();upstream.destroy()})}
 })
 const keys=['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE'];const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]))
 try{
  await new Promise(r=>vault.listen(0,'127.0.0.1',r));await new Promise(r=>proxy.listen(0,'127.0.0.1',r))
  process.env.HTTPS_PROXY=`http://127.0.0.1:${proxy.address().port}`;process.env.HTTP_PROXY=process.env.HTTPS_PROXY;delete process.env.ALL_PROXY;process.env.NO_PROXY='127.0.0.1';process.env.SSL_CERT_FILE=cert
  await pool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,\'Synthetic transfer\')',[workspace,owner])
  await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,\'Fixture\',\'fixture@example.invalid\',\'admin\')',[workspace,owner])
  const common={origin:'https://app.infisical.com',projectId:'89850d6a-f020-4936-863e-df77380dfe40'}
  const approval={transferId:randomUUID(),enrollmentId:id,ownerId:owner,workspaceId:workspace,sourcePrincipal:principal,provider:'claude',providerSubject:JSON.stringify(['fixture-account','fixture-org']),source:{...common,environment:'staging',grantPath:'/byos/pending-grants'},destination:{...common,environment:'prod',grantPath:'/byos/grants'},destinationOrigin:'https://app.aspectlylabs.com',destinationDatabaseIdentity:enrollmentBindingDatabaseIdentity(databaseUrl),sourceDigest:createHash('sha256').update(source).digest('hex'),sourceRevision:1,expiresAt:new Date(Date.now()+600000).toISOString(),deleteSource:false}
  let sourceGeneration=0, sourceLogins=0, custodyLogins=0
  const sourceTokens=universalAuthTokenProvider({origin:common.origin,credentials:()=>({clientId:'fixture-source',clientSecret:`fixture-source-${sourceGeneration}`}),fetch:async()=>{sourceLogins++;return Response.json({accessToken:'fixture-source-lease',tokenType:'Bearer',expiresIn:600})}})
  const custodyTokens=universalAuthTokenProvider({origin:common.origin,credentials:()=>({clientId:'fixture-custody',clientSecret:'fixture-custody-bootstrap'}),fetch:async()=>{custodyLogins++;return Response.json({accessToken:'fixture-destination-lease',tokenType:'Bearer',expiresIn:600})}})
  const client=new EnrollmentClient({binary:resolve('packages/subscription-worker/bin/mikka-subscription-enrollment'),infisicalOrigin:common.origin,project:common.projectId,environment:'prod',workloadToken:'',tokens:{get:()=>custodyTokens.getAccessToken(),reject:(_role,token)=>custodyTokens.rejectAccessToken(token)},sourceTokens,attemptPath:'/byos/enrollment-attempts',claimPath:'/byos/enrollment-claims',grantPath:'/byos/pending-grants',databaseUrl,canonicalGrantPath:'/byos/grants',accessPath:'/byos/access',transferApproval:approval,runtimeOrigin:'https://app.aspectlylabs.com'})
  const route=enrollmentBindHTTP({operator:async()=> 'operator:'+ 'b'.repeat(64),session:async req=>req.headers.get('cookie')==='fixture=valid'?{userId:owner}:null,workspace:async(user,ws)=>{const r=await pool.query('select 1 from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2 and status=\'active\'',[ws,user]);assert.equal(r.rowCount,1)},client:()=>client})
  const post=(session,body={id,workspaceId:workspace})=>route(new Request('https://app.aspectlylabs.com/mikka/api/subscriptions/enrollments/bind',{method:'POST',headers:{'content-type':'application/json',cookie:session?'fixture=valid':''},body:JSON.stringify(body)}))
  assert.equal((await post(false)).status,401);assert.equal((await post(true,{id,workspaceId:workspace,ownerId:'forged'})).status,409)
  for(const mode of ['receipt-get','claim-create','claim-read']) {
   denial=mode
   const beforeClaimReads=bindingClaimReads
   const denied=await post(true);assert.equal(denied.status,409)
   assert.deepEqual(await denied.json(),{error:'subscription_binding_unavailable'})
   await assert.rejects(sourceTokens.getAccessToken(),/vault_auth_unavailable/,`${mode} must invalidate source cache`)
   assert.equal(await custodyTokens.getAccessToken(),'fixture-destination-lease')
   assert.equal(custodyLogins,1);assert.equal(destinationWrites,0)
   if(mode==='claim-create')assert.equal(bindingClaimReads,beforeClaimReads,'denied create must not fall through to readable proof')
   assert.equal([...values.keys()].filter(k=>k.startsWith('prod/')).length,0)
   sourceGeneration++
  }
  denial=''
  const response=await post(true);assert.equal(response.status,200);const result=await response.json();assert.equal(result.state,'connected');assert.equal(result.cleanup.enrollment.state,'external_source_retained')
  const beforeDeniedRetry=destinationWrites
  denial='existing-claim-get'
  assert.equal((await post(true)).status,409)
  await assert.rejects(sourceTokens.getAccessToken(),/vault_auth_unavailable/)
  assert.equal(await custodyTokens.getAccessToken(),'fixture-destination-lease')
  assert.equal(destinationWrites,beforeDeniedRetry);assert.equal(custodyLogins,1)
  sourceGeneration++;denial=''
  const repeat=await post(true);assert.equal(repeat.status,200);assert.equal((await repeat.json()).id,result.id)
  const serialized=JSON.stringify(result);assert.ok(!serialized.includes('fixture-cross-env'));assert.equal(values.get(`staging/byos/pending-grants/mikka-byos-${id}`),source);assert.equal(deletes,0)
  assert.equal([...values.keys()].filter(k=>k.startsWith('prod/')).length,2)
  assert.equal(sourceLogins,5);assert.equal(custodyLogins,1)
 }finally{
  for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k]}
  for(const s of sockets)s.destroy();proxy.closeAllConnections();vault.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>vault.close(r))]);await pool.end();await rm(dir,{recursive:true,force:true})
 }
})
