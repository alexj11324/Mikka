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
 else if(u.pathname.startsWith('/v10/projects/'))body={envs:[]}
 else if(u.pathname==='/v1/integrations/configurations')body={configurations:[]}
 else assert.fail('unexpected route')
 return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}})
 }
 await prepare({env:{ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/opaque',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic',VERCEL_TEAM_TOKEN:'synthetic'},fetcher,report});assert.equal(report.result,'source_and_sync_prepared');assert.equal(report.connectionConnectRequired,false);assert.deepEqual(report.createdKeys,[]);assert.equal(report.syncId,'existing')
})
