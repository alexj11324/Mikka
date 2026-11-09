import assert from 'node:assert/strict'
import test from 'node:test'
import { changeIssueScopeLocally } from '../lib/issue-scope-store'

const workspaceId='53100000-0000-4000-8000-000000000004'
const issueId='53100000-0000-4000-8000-000000000005'
function reset(extra = {}) {
  const probe={
    workspace:{id:workspaceId,kind:'team',ownerId:'owner'},activeMembers:new Set(['owner','other']),locks:[] as string[],
    issue:{id:issueId,userId:'owner',workspaceId,ownershipState:'bound',revision:1,scope:'workspace',scopeVersion:1,status:'todo',linearSyncPolicy:'explicit',linearSyncBlocked:false,content:{type:'doc'}},
    link:false,outgoing:false,publication:false,writes:0,versions:0,...extra,
  }
  ;(globalThis as typeof globalThis & {scopeStoreProbe:typeof probe}).scopeStoreProbe=probe
  return probe
}
const input={id:issueId,revision:1,scope:'personal' as const}
test('one owner action disables provider sync without changing the task tenant; replay remains stale',async()=>{
  const p=reset()
  assert.ok('issue' in await changeIssueScopeLocally('owner',input,{allowLinkedPersonal:false}))
  assert.equal(p.writes,1);assert.equal(p.versions,1)
  assert.equal(p.issue.workspaceId,workspaceId);assert.equal(p.issue.scope,'workspace')
  assert.equal(p.issue.linearSyncPolicy,'disabled');assert.equal(p.issue.linearSyncBlocked,true)
  assert.deepEqual(p.locks,['workspaces','workspace_members','issues'])
  assert.deepEqual(await changeIssueScopeLocally('owner',input,{allowLinkedPersonal:false}),{error:'issueStale'})
  assert.equal(p.writes,1)
})
test('an owner whose workspace membership was revoked cannot change provider policy',async()=>{
  const p=reset();p.activeMembers.delete('owner')
  await assert.rejects(changeIssueScopeLocally('owner',input,{allowLinkedPersonal:false}),{code:'issueNotFound'})
  assert.equal(p.writes,0);assert.equal(p.versions,0)
  assert.equal(p.issue.workspaceId,workspaceId);assert.equal(p.issue.linearSyncPolicy,'explicit')
  assert.deepEqual(p.locks,[])
})
test('external link, retained publication and failed outbox each block before a write',async()=>{
  for(const field of ['link','publication','outgoing']){
    const p=reset({[field]:true})
    assert.deepEqual(await changeIssueScopeLocally('owner',input,{allowLinkedPersonal:false}),{error:'issueScopeInLinear'},field)
    assert.equal(p.writes,0);assert.equal(p.versions,0)
  }
})
test('removing a blanket confirmation does not remove owner, revision or supplied digest checks',async()=>{
  let p=reset()
  assert.deepEqual(await changeIssueScopeLocally('other',input,{allowLinkedPersonal:false}),{error:'issueScopeOwnerOnly'});assert.equal(p.writes,0)
  p=reset()
  assert.deepEqual(await changeIssueScopeLocally('owner',{...input,revision:2},{allowLinkedPersonal:false}),{error:'issueStale'});assert.equal(p.writes,0)
  p=reset()
  assert.deepEqual(await changeIssueScopeLocally('owner',input,{allowLinkedPersonal:false,confirmation:'0'.repeat(64)}),{error:'issueStale'});assert.equal(p.writes,0)
})
