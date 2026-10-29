import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const probe={issueOwner:'owner',writes:0,dispatch:0}
;(globalThis as typeof globalThis & {scopeActionProbe:typeof probe}).scopeActionProbe=probe

test('the legacy UI action refuses untargeted workspace promotion before any write or dispatch',async()=>{
  const {setIssueScope}=await import('../app/actions/issues')
  const result=await setIssueScope({id:randomUUID(),revision:1,scope:'workspace'})
  assert.deepEqual(result,{error:'issueScopeTeamRequired'})
  assert.equal(probe.writes,0);assert.equal(probe.dispatch,0)
})

test('workspace rejection does not bypass the owner authorization check',async()=>{
  probe.issueOwner='someone-else'
  const {setIssueScope}=await import('../app/actions/issues')
  const result=await setIssueScope({id:randomUUID(),revision:1,scope:'workspace'})
  assert.deepEqual(result,{error:'issueScopeOwnerOnly'})
  assert.equal(probe.writes,0);assert.equal(probe.dispatch,0)
})
