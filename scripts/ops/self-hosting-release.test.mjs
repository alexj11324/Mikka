import test from 'node:test'
import assert from 'node:assert/strict'
import {secretPlan,syncBody,TARGET,REQUIRED,reference,assertExecution} from './self-hosting-release.mjs'
const rows=()=>Object.entries(REQUIRED).map(([secretKey,secretPath])=>({secretKey:secretKey==='EXPO_ACCESS_TOKEN'?'EXPO_TOKEN':secretKey,secretPath}))
test('only known source references enter private sync; Neon variables stay provider owned',()=>{const p=secretPlan(rows());assert.equal(p.BETTER_AUTH_SECRET,'${prod.vercel.BETTER_AUTH_SECRET}');assert.equal(Buffer.from(p.MIKKA_CLOUD_DATA_KEY,'base64').length,32);assert.equal(p.DATABASE_URL,'${prod.neon.DATABASE_URL}');assert.equal(p.DATABASE_URL_UNPOOLED,'${prod.neon.DATABASE_URL_UNPOOLED}');const s=syncBody();assert.equal(s.destinationConfig.app,TARGET.app);assert.equal(s.destinationConfig.env,'production');assert.equal(s.syncOptions.includeAllSubFolders,false);assert.equal(s.syncOptions.disableSecretDeletion,true)})
test('existing data key is retained or referenced and ambiguous keys block before writes',()=>{assert.equal(secretPlan([...rows(),{secretKey:'MIKKA_CLOUD_DATA_KEY',secretPath:TARGET.path}]).MIKKA_CLOUD_DATA_KEY,undefined);assert.equal(secretPlan([...rows(),{secretKey:'MIKKA_CLOUD_DATA_KEY',secretPath:'/existing'}]).MIKKA_CLOUD_DATA_KEY,'${prod.existing.MIKKA_CLOUD_DATA_KEY}');assert.throws(()=>secretPlan([...rows(),{secretKey:'MIKKA_CLOUD_DATA_KEY',secretPath:'/a'},{secretKey:'MIKKA_CLOUD_DATA_KEY',secretPath:'/b'}]),/AMBIGUOUS/);assert.throws(()=>secretPlan([]),/SOURCE_REQUIRED/);assert.throws(()=>reference('../x','KEY'),/SCOPE/)})
test('untrusted execution cannot start a release',()=>{assert.throws(()=>assertExecution({}, {},'a'.repeat(40),TARGET.base,[]),/SCOPE/)})

// Prepare dispatch uses a YAML block scalar for the colon-bearing commit prefix.

// API refusals are classified without printing raw errors or request bodies.

// Only the exact closed PR316 Preview sync can be reused; production syncs are not retargeted.

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
