import test from 'node:test'
import assert from 'node:assert/strict'
import {secretPlan,syncBody,TARGET,REQUIRED,reference,assertExecution,requestNativeBuildReadback} from './self-hosting-release.mjs'
import { smokeAccount, verifyDelivery, acceptanceCode } from './self-hosting-cloud-acceptance.mjs'
import { createHmac, generateKeyPairSync, verify } from 'node:crypto'
test('business acceptance refuses non-shared accounts and never projects arbitrary error text',()=>{assert.throws(()=>smokeAccount({SMOKE_OWNER_EMAIL:'someone@example.invalid',SMOKE_OWNER_PASSWORD:'fixture'}),/SMOKE_ACCOUNT_REQUIRED/);assert.equal(acceptanceCode(Error('secret-value-private')), 'ACCEPTANCE_FAILED')})
test('webhook receipt checks raw body, registered secret and freshness',()=>{const now=1800000000000,t=now/1000,body='{"action":"created"}',secret='synthetic-only';const sig=`t=${t},v1=${createHmac('sha256',secret).update(`${t}.${body}`).digest('hex')}`;assert.equal(verifyDelivery(body,sig,secret,now),true);assert.equal(verifyDelivery(body+' ',sig,secret,now),false);assert.equal(verifyDelivery(body,sig,'wrong',now),false);assert.equal(verifyDelivery(body,sig,secret,now+301000),false)})
const rows=()=>Object.entries(REQUIRED).map(([secretKey,secretPath])=>({secretKey:secretKey==='EXPO_ACCESS_TOKEN'?'EXPO_TOKEN':secretKey,secretPath}))
test('only known source references enter private sync; Neon variables stay provider owned',()=>{const p=secretPlan(rows());assert.equal(p.BETTER_AUTH_SECRET,'${prod.vercel.BETTER_AUTH_SECRET}');assert.equal(Buffer.from(p.MIKKA_CLOUD_DATA_KEY,'base64').length,32);assert.equal(p.DATABASE_URL,'${prod.neon.DATABASE_URL}');assert.equal(p.DATABASE_URL_UNPOOLED,'${prod.neon.DATABASE_URL_UNPOOLED}');const s=syncBody();assert.equal(s.destinationConfig.app,TARGET.app);assert.equal(s.destinationConfig.env,'production');assert.equal(s.syncOptions.includeAllSubFolders,false);assert.equal(s.syncOptions.disableSecretDeletion,true)})
test('existing data key is retained or referenced and ambiguous keys block before writes',()=>{assert.equal(secretPlan([...rows(),{secretKey:'MIKKA_CLOUD_DATA_KEY',secretPath:TARGET.path}]).MIKKA_CLOUD_DATA_KEY,undefined);assert.equal(secretPlan([...rows(),{secretKey:'MIKKA_CLOUD_DATA_KEY',secretPath:'/existing'}]).MIKKA_CLOUD_DATA_KEY,'${prod.existing.MIKKA_CLOUD_DATA_KEY}');assert.throws(()=>secretPlan([...rows(),{secretKey:'MIKKA_CLOUD_DATA_KEY',secretPath:'/a'},{secretKey:'MIKKA_CLOUD_DATA_KEY',secretPath:'/b'}]),/AMBIGUOUS/);assert.throws(()=>secretPlan([]),/SOURCE_REQUIRED/);assert.throws(()=>reference('../x','KEY'),/SCOPE/)})
test('untrusted execution cannot start a release',()=>{assert.throws(()=>assertExecution({}, {},'a'.repeat(40),TARGET.base,[]),/SCOPE/)})

// Prepare dispatch uses a YAML block scalar for the colon-bearing commit prefix.

// API refusals are classified without printing raw errors or request bodies.

// Only the exact closed PR316 Preview sync can be reused; production syncs are not retargeted.
// Production protocol registration follows an established, publicly reachable receiver.
// DNS propagation diagnostics retain only fixed network causes and HTTP status.
// Business receipts attest both deployed sources before and after exact cleanup.
// Hosted metering sends one fixed Flash request after the existing model-policy guard; no paid retries.

// Installation inventory uses the documented account view.

// Legacy Neon storage inventory is read using existing project ownership.

// Existing native Sync readback never requires organization App Connection Connect.

test('a configured native Sync can be read back without organization connection permissions',async()=>{
 const {prepare}=await import('./self-hosting-release.mjs');const report={requests:[]};const source=rows();const plan=secretPlan(source);const metadata=[...source,...Object.keys(plan).map(secretKey=>({secretKey,secretPath:TARGET.path}))];const requests=[]
 const fetcher=async(value,init={})=>{const u=new URL(value);requests.push(u.pathname);assert.ok(!u.pathname.includes('app-connections'));assert.equal(init.method??'GET',u.pathname.includes('/oidc-auth/login')?'POST':'GET');let body
 if(u.hostname.endsWith('.actions.githubusercontent.com'))body={value:'synthetic-oidc'}
 else if(u.pathname.endsWith('/oidc-auth/login'))body={accessToken:'synthetic-infi',tokenType:'Bearer'}
 else if(u.pathname==='/v9/projects/'+TARGET.app)body={id:TARGET.app,accountId:TARGET.team,name:'mikka-cloud'}
 else if(u.pathname==='/api/v4/secrets')body={secrets:metadata}
 else if(u.pathname==='/api/v2/folders')body={folders:[{path:TARGET.path}]}
 else if(u.pathname==='/api/v1/secret-syncs/vercel')body={secretSyncs:[{id:'existing',connection:{id:TARGET.connection},folder:{path:TARGET.path},environment:{slug:'prod'},syncOptions:{disableSecretDeletion:true,includeAllSubFolders:false},destinationConfig:{app:TARGET.app,env:'production'}}]}
 else if(u.pathname.startsWith('/v10/projects/'))body={envs:u.pathname.includes(TARGET.publicApp)?['DATABASE_URL','DATABASE_URL_UNPOOLED'].map(key=>({id:'fixture_'+key,key,target:['production'],configurationId:'fixture-neon-integration'})):[]}
 else if(u.pathname.startsWith('/v1/projects/'+TARGET.publicApp+'/env/'))body={key:u.pathname.split('/').at(-1).replace('fixture_',''),value:'postgresql://fixture:isolated@fixture.aws.neon.tech/test?sslmode=require'}
 else if(u.pathname.startsWith('/api/v4/secrets/'))body={secret:{secretKey:u.pathname.split('/').at(-1),secretValue:'postgresql://fixture:isolated@fixture.aws.neon.tech/test?sslmode=require'}}
 else if(u.pathname==='/v1/integrations/configurations')body={configurations:[]}
 else if(u.pathname==='/v1/storage/stores')body={stores:[]}
 else assert.fail('unexpected route')
 return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}})
 }
 await prepare({env:{ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/opaque',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic',VERCEL_TEAM_TOKEN:'synthetic'},fetcher,report});assert.equal(report.result,'source_and_sync_prepared');assert.equal(report.connectionConnectRequired,false);assert.deepEqual(report.createdKeys,[]);assert.equal(report.syncId,'existing');assert.ok(report.neonSnapshotChecks.every(x=>x.matchesLiveProvider));assert.deepEqual(report.refreshedPrivateDatabaseKeys,[]);assert.ok(!JSON.stringify(report).includes('fixture:isolated'))
})

test('production readiness uses only the shared account and logs closed capability metadata',async()=>{
 const {readiness}=await import('./self-hosting-release.mjs');const email='operator+mikka-smoke@example.test',report={http:[]},calls=[];const fixtures={
 '/mikka/api/auth/sign-in/email':{ok:true},'/mikka/api/auth/get-session':{user:{id:'private-user-id',email}},'/mikka/api/version':{build:'a'.repeat(40)},'/mikka/cloud/health':{ok:true},'/mikka/cloud/.well-known/oauth-authorization-server':{issuer:'https://app.aspectlylabs.com/mikka/cloud'},'/mikka/cloud/v1/management/context':{csrfToken:'private-csrf',workspaces:[{id:'private-team-id',name:'private-team-name',kind:'team',role:'admin'}],enabledScopes:['github','push','models']},'/mikka/api/integrations/github':{configured:true,connected:true,installed:true,repositories:[{name:'private-repo-name'}]},'/mikka/api/bots':[], '/mikka/api/auth/sign-out':{success:true}}
 const fetcher=async(url,init)=>{const u=new URL(url);assert.ok(['app.aspectlylabs.com','mikka-cloud.vercel.app'].includes(u.host));assert.equal(init.redirect,'error');calls.push(u.pathname);const body=fixtures[u.pathname];assert.ok(body);return new Response(JSON.stringify(body),{headers:{'content-type':'application/json',...(u.pathname.endsWith('sign-in/email')?{'set-cookie':'fixture=private-cookie; Secure; HttpOnly'}:{})}})}
 await readiness({env:{SMOKE_OWNER_EMAIL:email,SMOKE_OWNER_PASSWORD:'private-password'},fetcher,report});assert.equal(report.result,'production_readiness_verified');assert.equal(report.teamAdminAvailable,true);assert.equal(report.ownSessionSignedOut,true);assert.equal(report.businessAcceptanceComplete,false);for(const value of ['private-cookie','private-password','private-csrf','private-team-name','private-repo-name',email])assert.ok(!JSON.stringify(report).includes(value));assert.equal(calls.at(-1),'/mikka/api/auth/sign-out')
})
test('readiness refuses a non-smoke account before any network request',async()=>{const {readiness}=await import('./self-hosting-release.mjs');let calls=0;await assert.rejects(readiness({env:{SMOKE_OWNER_EMAIL:'alex@example.test',SMOKE_OWNER_PASSWORD:'synthetic'},fetcher:async()=>{calls++},report:{http:[]}}),/SHARED_SMOKE_ACCOUNT_REQUIRED/);assert.equal(calls,0)})

// Production readiness also reads fixed project/alias metadata inside the runner.

test('runtime log summaries expose only closed causes and public package names',async()=>{const {runtimeLogSummary}=await import('./self-hosting-release.mjs');const raw="Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'server-only' imported from /private/source.ts\nBearer private-secret-value";const v=runtimeLogSummary(raw);assert.deepEqual(v.missingPackages,['server-only']);assert.deepEqual(v.codes,['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND']);assert.ok(!JSON.stringify(v).includes('private-secret'));assert.ok(!JSON.stringify(v).includes('/private/source'))})

// Runtime diagnostics also consume the fixed deployment's documented bounded log stream.

test('missing packaged auth data is classified without printing its filesystem path',async()=>{const {runtimeLogSummary}=await import('./self-hosting-release.mjs');const v=runtimeLogSummary("Error: ENOENT open '/var/task/lib/abuse/data/disposable-email-domains.txt'");assert.deepEqual(v.codes,['ENOENT']);assert.equal(v.missingAuthData,true);assert.ok(!JSON.stringify(v).includes('/var/task'))})

// Metering-only mode uses the existing verified personal workspace and does not mint extra GitHub tokens.

test('community staging source guard accepts the six reviewed operations files and rejects product edits',()=>{
 const head='a'.repeat(40),env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:TARGET.repo,GITHUB_REPOSITORY_ID:'1427517699',GITHUB_REPOSITORY_OWNER_ID:'183887963',GITHUB_ACTOR:'alexj11324',GITHUB_EVENT_NAME:'push',GITHUB_REF:TARGET.ref,GITHUB_SHA:head}
 const event={repository:{full_name:TARGET.repo},ref:TARGET.ref,after:head,forced:false}
 const paths=['.github/workflows/infisical-cloud-capabilities.yml','scripts/ops/self-hosting-release.mjs','scripts/ops/self-hosting-release.test.mjs','scripts/ops/self-hosting-cloud-acceptance.mjs','scripts/ops/self-hosting-subscription-acceptance.mjs','scripts/ops/self-hosting-subscription-acceptance.test.mjs']
 assert.doesNotThrow(()=>assertExecution(env,event,head,TARGET.base,paths))
 assert.throws(()=>assertExecution(env,event,head,TARGET.base,[...paths.slice(0,5),'lib/auth.ts']),/EXECUTION_SCOPE/)
 assert.throws(()=>assertExecution(env,event,head,'b'.repeat(40),paths),/EXECUTION_SCOPE/)
})

// The isolated image contract validates real signup, signed consent and MCP without model requests.

// Staging checkpoint: access-only fixture constraints and owned volume cleanup verified.

test('native readback dispatch can only inspect the known existing build and never requests a new build or submission', async () => {
 const report = {}, env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: TARGET.repo, GITHUB_REF: TARGET.ref, GITHUB_TOKEN: 'synthetic-only' }
 const calls = []
 await requestNativeBuildReadback(env, report, async (url, init) => { calls.push({ url, body: JSON.parse(init.body), redirect: init.redirect }); return new Response(null, { status: 204 }) })
 assert.equal(calls.length, 1)
 assert.equal(calls[0].url, 'https://api.github.com/repos/alexj11324/Mikka/actions/workflows/mobile-native.yml/dispatches')
 assert.deepEqual(calls[0].body, { ref: 'main', inputs: { submit: 'false', existing_build_id: '958c42e7-3b00-460d-b100-c6b0426dbb1d', expected_commit: '62281b1995cb8fef16e7604dc1ea9a29c4dbbe32' } })
 assert.equal(report.nativeBuildReadback.newBuildRequested, false)
 assert.equal(report.nativeBuildReadback.submit, false)
 await assert.rejects(requestNativeBuildReadback({ ...env, GITHUB_REF: 'refs/heads/arbitrary' }, {}, () => { throw Error('must not call') }), /NATIVE_READBACK_SCOPE/)
})

test('native dispatch denial retains the exact action and HTTP status without returning the workload token', async () => {
 const report = {}, env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: TARGET.repo, GITHUB_REF: TARGET.ref, GITHUB_TOKEN: 'synthetic-do-not-return' }
 await assert.rejects(requestNativeBuildReadback(env, report, async () => new Response(null, { status: 403 })), /NATIVE_READBACK_DISPATCH_FAILED/)
 assert.deepEqual(report.requests, [{ operation: 'native_readback_dispatch', status: 403 }])
 assert.ok(!JSON.stringify(report).includes(env.GITHUB_TOKEN))
})

test('existing TestFlight readback signs a short GET-only token and emits only fixed build states', async () => {
 const { inspectExistingTestflightBuild } = await import('./self-hosting-release.mjs')
 const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
 const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
 const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: TARGET.repo, GITHUB_REF: TARGET.ref, ASC_API_KEY_P8: key, ASC_API_KEY_ID: 'FIXTUREKEY', ASC_API_ISSUER_ID: '00000000-0000-4000-8000-000000000001' }
 const report = {}, now = 1800000000000
 await inspectExistingTestflightBuild(env, report, async (value, init) => {
  const url = new URL(value), token = init.headers.authorization.slice(7), [header, payload, signature] = token.split('.')
  assert.equal(url.origin, 'https://api.appstoreconnect.apple.com')
  assert.equal(url.pathname, '/v1/builds')
  assert.equal(url.searchParams.get('filter[app]'), '6829300983')
  assert.equal(url.searchParams.get('filter[version]'), '9')
  assert.equal(url.searchParams.get('filter[preReleaseVersion.version]'), '1.0.0')
  assert.equal(url.searchParams.get('filter[preReleaseVersion.platform]'), 'IOS')
  assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error')
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'ES256')
  const claims = JSON.parse(Buffer.from(payload, 'base64url'))
  assert.deepEqual(claims.scope, ['GET ' + url.pathname + url.search])
  assert.equal(claims.aud, 'appstoreconnect-v1'); assert.equal(claims.iat, now / 1000); assert.equal(claims.exp - claims.iat, 300)
  assert.ok(verify('sha256', Buffer.from(header + '.' + payload), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')))
  return new Response(JSON.stringify({ data: [{ id: 'fixture-build', type: 'builds', attributes: { version: '9', processingState: 'VALID', expired: false, arbitrary: 'never-return-private' }, relationships: { buildBetaDetail: { data: { id: 'fixture-beta' } } } }], included: [{ id: 'fixture-beta', type: 'buildBetaDetails', attributes: { internalBuildState: 'IN_BETA_TESTING', externalBuildState: 'WAITING_FOR_BETA_REVIEW', privateEmail: 'do-not-return@example.invalid' } }] }), { headers: { 'content-type': 'application/json' } })
 }, () => now)
 assert.equal(report.testflight.processingState, 'VALID'); assert.equal(report.testflight.internalBuildState, 'IN_BETA_TESTING')
 assert.equal(report.testflight.expired, false); assert.equal(report.testflight.physicalDeviceExercised, false)
 for (const value of ['never-return-private', 'do-not-return', key, 'FIXTUREKEY']) assert.ok(!JSON.stringify(report).includes(value))
 await assert.rejects(inspectExistingTestflightBuild({ ...env, GITHUB_REF: 'refs/heads/arbitrary' }, {}, () => assert.fail('must not request')), /APPLE_READBACK_SCOPE/)
})

test('Apple API denial preserves action/status without exposing raw provider error bodies', async () => {
 const { inspectExistingTestflightBuild } = await import('./self-hosting-release.mjs')
 const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), report = {}
 const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: TARGET.repo, GITHUB_REF: TARGET.ref, ASC_API_KEY_P8: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), ASC_API_KEY_ID: 'FIXTUREKEY', ASC_API_ISSUER_ID: '00000000-0000-4000-8000-000000000001' }
 await assert.rejects(inspectExistingTestflightBuild(env, report, async () => new Response('never-return-raw-provider-error', { status: 403 })), /APPLE_READBACK_HTTP/)
 assert.deepEqual(report.requests, [{ operation: 'apple_existing_build', status: 403 }])
 assert.ok(!JSON.stringify(report).includes('never-return'))
})

// Final release checkpoint: public ce67; production execution follows private main READY.

// Public protocol checkpoint: ce67 bridge; native/full threads follow the final fixed source.

// Public release checkpoint: dispatch uses the commit subject prefix, independent of its explanatory body.

// YAML mode expressions use block scalars because the commit prefix contains a colon.

// PR comments use explicit Pull requests write; Apple/EAS readbacks run independently of protocol completion.

// Community release pin contains native-auth fix1668; production writers must complete before activation.

// Source access follows live production project/identity configuration; no new credentials or roles.

// Secret environment values are read from their existing Infisical sync source, never Vercel write-only values.

// Model list materializes virtual IDs before removal; failure receipts exclude provider text.

// Published artifact and actual served control-plane build identify this run; unserved Git HEAD is metadata only.

// Repository failures retain only fixed classifications; cleanup awaits the terminal live push.

// Verify the normal fixture reader before VMs; source-only error matches retain no runtime messages.

// Lease diagnosis uses the frozen authority function read-only and unchanged heartbeat responses.

// Isolated stop-writer observation retains fixed query kinds/fingerprints only, never SQL or arguments.

// Compare only owner-event provenance booleans; verify enabled Manifest preparation without creating an App.

// Fixed A23 image and approved ce67 templates remain independent of the reviewed live047 quota-read optimization.

// PR1692 candidate is identified separately; it cannot claim a published main image.
