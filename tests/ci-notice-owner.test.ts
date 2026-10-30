import { strict as assert } from 'node:assert'
import { mock, test } from 'node:test'
import './fixtures/activity-runtime.mjs'

let active=false,force=false,inserts=0
mock.module(new URL('../lib/github/ci/authority.ts',import.meta.url).href,{namedExports:{
  acquireCiMembership:async(_i:unknown,_u:unknown,_o:unknown,_p:unknown,shared:boolean)=>{force=shared;if(shared&&!active)throw Error('revoked');return {held:shared,async check(){},async close(){}}},
  ciIssueAuthorized:()=>true,
}})
mock.module(new URL('../lib/credentials/chat-guard.ts',import.meta.url).href,{namedExports:{assertCredentialSafeChat:async()=>{}}})
const issue={userId:'owner',scope:'workspace',scopeVersion:1,content:{}}
const pool={async query(){return {rows:[issue]}},async connect(){return {async query(sql:string){if(sql.includes('FROM issues WHERE'))return {rows:[issue]};if(sql.includes('INSERT INTO coordinator_events')){inserts++;return {rowCount:1}};return {rows:[]}},release(){}}}}
const identity={userId:'owner',issueId:'i',remoteKey:'r',prNumber:1,originRunId:'run',scopeVersion:1,generation:'1',watchId:'watch'}
test('workspace issue owner must remain an active member before a notice',async()=>{
  const {recordCiAttention}=await import('../lib/github/ci/notice')
  await assert.rejects(recordCiAttention(pool as never,identity,'fixture','message'));assert.equal(force,true);assert.equal(inserts,0)
  active=true;assert.equal(await recordCiAttention(pool as never,identity,'fixture','message'),true);assert.equal(inserts,1)
})
