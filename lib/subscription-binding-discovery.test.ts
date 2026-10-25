import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {subscriptionRepositoryIfInstalled} from './subscription-binding-discovery'
test('persisted binding discovery does not need enabled runtime; pre-migration returns none',async()=>{
 for(const installed of [true,false]){
  const db={query:async()=>({rows:[{installed}]})}
  assert.equal(Boolean(await subscriptionRepositoryIfInstalled(db as never)),installed)
 }
 await assert.rejects(subscriptionRepositoryIfInstalled({query:async()=>{throw new Error('metadata unavailable')}} as never))
})
test('claim and own-harness routes discover persisted intent independently of runtime flag',()=>{
 const claim=readFileSync('app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts','utf8')
 assert.ok(claim.indexOf('subscriptionRepositoryIfInstalled(pool)')<claim.indexOf("process.env.MIKKA_BYOS_ENABLED !== '1'"))
 assert.ok(claim.indexOf("Subscription runtime is disabled.")<claim.indexOf('const leaseExpiresAt ='))
 const agent=readFileSync('app/api/agent/route.ts','utf8')
 assert.ok(agent.includes('subscriptionRepositoryIfInstalled(pool)'))
 assert.ok(!agent.includes("!modelSource && process.env.MIKKA_BYOS_ENABLED"))
})
