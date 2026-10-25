import test from 'node:test'
import assert from 'node:assert/strict'
import {subscriptionRepositoryIfInstalled,nativeSubscriptionForClaim} from './subscription-binding-discovery'
const binding={id:'20000000-0000-4000-8000-000000000001',ownerId:'owner',workspaceId:'20000000-0000-4000-8000-000000000002',consumerId:'consumer',connectionId:'20000000-0000-4000-8000-000000000003',connectionRevision:1,route:'claude_code_cli',modelId:'fixture'}
test('persisted binding discovery does not need runtime credentials; metadata failures do not mean unbound',async()=>{
 for(const installed of [true,false]) assert.equal(Boolean(await subscriptionRepositoryIfInstalled({query:async()=>({rows:[{installed}]})} as never)),installed)
 await assert.rejects(subscriptionRepositoryIfInstalled({query:async()=>{throw new Error('metadata unavailable')}} as never))
})
test('disabled runtime refuses a persisted native binding and preserves ordinary unbound claims',async()=>{
 const database=(bound:boolean)=>({query:async(sql:string,args?:unknown[])=>{
  if(sql.includes('to_regclass'))return {rows:[{installed:true}]}
  assert.ok(args?.includes('owner'),'every binding lookup scoped to real owner')
  return {rows:bound?[binding]:[]}
 }})
 await assert.rejects(nativeSubscriptionForClaim(database(true) as never,'owner','consumer','claude_code',false),/backend_unavailable/)
 assert.equal((await nativeSubscriptionForClaim(database(true) as never,'owner','consumer','claude_code',true))?.id,binding.id)
 assert.equal(await nativeSubscriptionForClaim(database(false) as never,'owner','consumer','claude_code',false),null)
})
