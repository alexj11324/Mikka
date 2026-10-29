import assert from 'node:assert/strict'
import test from 'node:test'
import { changeIssueScopeLocally } from '../lib/issue-scope-store'

function reset(extra = {}) {
  const probe={issue:{id:'issue',userId:'owner',revision:1,scope:'workspace',scopeVersion:1},link:false,outgoing:false,publication:false,writes:0,versions:0,...extra}
  ;(globalThis as typeof globalThis & {scopeStoreProbe:typeof probe}).scopeStoreProbe=probe
  return probe
}
const input={id:'issue',revision:1,scope:'personal' as const}
test('one owner action retires a local-only task; replay remains stale',async()=>{
  const p=reset()
  assert.ok('issue' in await changeIssueScopeLocally('owner',input,{allowLinkedPersonal:false}))
  assert.equal(p.writes,1);assert.equal(p.versions,1)
  assert.deepEqual(await changeIssueScopeLocally('owner',input,{allowLinkedPersonal:false}),{error:'issueStale'})
  assert.equal(p.writes,1)
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
