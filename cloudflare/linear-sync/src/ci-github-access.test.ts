import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { verifyScopedCiAccess } from './ci-github-access'
import type { CiPollLease } from './ci-poller'
const lease:CiPollLease={id:'fixture',generation:'1',attempt:0,observation:null,token:'lease',binding:{userId:'owner',issueId:'issue',remoteKey:'v2/github.com/example/repo',prNumber:1,installationId:4,repositoryId:5,githubAccountId:'123',branch:'feature',originRunId:'run',scopeVersion:1,issueOwner:'owner',issueScope:'personal'}}
test('scoped token verifies current person and repository, and rejects revoked access',async()=>{
  let revoked=false,calls=0
  const fetcher:typeof fetch=async(input,init)=>{calls++;const url=String(input);assert.match(url,/^https:\/\/api\.github\.com\//);assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-token');if(url.endsWith('/user/123'))return Response.json({id:123,login:'fixture'});if(url.endsWith('/permission'))return Response.json({permission:revoked?'read':'write',user:{id:123}});return Response.json({id:5,full_name:'example/repo'})}
  await verifyScopedCiAccess(lease,'synthetic-token',new AbortController().signal,fetcher);assert.equal(calls,3)
  revoked=true;await assert.rejects(verifyScopedCiAccess(lease,'synthetic-token',new AbortController().signal,fetcher))
})
