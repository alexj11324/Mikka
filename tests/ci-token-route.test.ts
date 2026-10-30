import { strict as assert } from 'node:assert'
import { mock, test } from 'node:test'
import './fixtures/activity-runtime.mjs'

const watchId='00000000-0000-4000-8000-000000000001',leaseId='00000000-0000-4000-8000-000000000002'
const row={userId:'fixture',issueId:'00000000-0000-4000-8000-000000000003',remoteKey:'v2/github.com/example/repo',prNumber:1,scopeVersion:1,originRunId:'00000000-0000-4000-8000-000000000004',issueOwner:'fixture',scope:'personal',content:{},currentScopeVersion:1,installationId:'55',repositoryId:'77',githubAccountId:'123',branch:'feature'}
let live=true,blocked=false,metadata:unknown,providerCalls=0
const query=async(sql:string)=>{if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[]};return {rowCount:live?1:0,rows:live?[row]:[]}}
const pool={query,async connect(){return {query,release(){}}}}
mock.module(new URL('../lib/db/index.ts',import.meta.url).href,{namedExports:{pool}})
mock.module(new URL('../lib/github/ci/authority.ts',import.meta.url).href,{namedExports:{acquireCiMembership:async()=>{if(blocked)throw Error('revoked');return {held:false,async check(){if(blocked)throw Error('revoked')},async close(){}}},ciIssueAuthorized:()=>true}})
mock.module(new URL('../lib/github/run-pull-request.ts',import.meta.url).href,{namedExports:{verifyGitHubRepositoryAccess:async()=>({installationId:55,repositoryId:77})}})
mock.module(new URL('../lib/suggestions/github-redelivery.ts',import.meta.url).href,{namedExports:{githubAppJwt:()=> 'synthetic-app-jwt'}})
const {POST}=await import('../app/api/cron/ci-token/route')
const body=JSON.stringify({watchId,leaseId,generation:'1'})
const request=(token:string)=>new Request('http://localhost/api/cron/ci-token',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body})

test('short token issuance requires live authority and grants only one repository read access',async()=>{
  const previous={secret:process.env.CRON_SECRET,id:process.env.GITHUB_APP_ID,key:process.env.GITHUB_APP_PRIVATE_KEY,fetch:globalThis.fetch}
  process.env.CRON_SECRET='synthetic-ci-token-secret';process.env.GITHUB_APP_ID='55';process.env.GITHUB_APP_PRIVATE_KEY='synthetic'
  globalThis.fetch=async(input,init)=>{providerCalls++;assert.equal(String(input),'https://api.github.com/app/installations/55/access_tokens');metadata=JSON.parse(String(init?.body));return Response.json({token:'synthetic-short-token',expires_at:new Date(Date.now()+3600000).toISOString()})}
  try {
    assert.equal((await POST(request('wrong'))).status,401);assert.equal(providerCalls,0)
    live=false;assert.equal((await POST(request(process.env.CRON_SECRET))).status,409);assert.equal(providerCalls,0)
    live=true;blocked=true;assert.equal((await POST(request(process.env.CRON_SECRET))).status,409);assert.equal(providerCalls,0)
    blocked=false;const response=await POST(request(process.env.CRON_SECRET));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store')
    assert.deepEqual(metadata,{repository_ids:[77],permissions:{metadata:'read',pull_requests:'read',checks:'read',statuses:'read',contents:'read',actions:'read'}})
    assert.equal((await response.json()).token,'synthetic-short-token')
  } finally {globalThis.fetch=previous.fetch;for(const [name,value] of [['CRON_SECRET',previous.secret],['GITHUB_APP_ID',previous.id],['GITHUB_APP_PRIVATE_KEY',previous.key]] as const){if(value===undefined)delete process.env[name];else process.env[name]=value}}
})
