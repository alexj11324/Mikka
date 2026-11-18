import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runtimeMonitorOwner } from './runtime-monitor-owner.mjs'

const product='b'.repeat(40)
test('runtime ownership requires a verified Cloudflare origin and fails closed otherwise',async()=>{
  assert.deepEqual(await runtimeMonitorOwner({authority:async()=>({provider:'cloudflare',sha:product})}),
    {runtime:'cloudflare',product,reason:'serving_cloudflare'})
  await assert.rejects(runtimeMonitorOwner({authority:async()=>({provider:'vercel',sha:product})}),/cloudflare_runtime_not_serving/)
  await assert.rejects(runtimeMonitorOwner({authority:async()=>{throw Error('dns')}}),/dns/)
})
test('the production schedule retains provider accounting without the retired Vercel collector',async()=>{
  const file=await readFile(new URL('../../.github/workflows/production-smoke.yml',import.meta.url),'utf8')
  const section=file.slice(file.indexOf('  deployment-comparison:'))
  assert.doesNotMatch(section,/VERCEL_TEAM_TOKEN|deployment-regression\.mjs|runtime-outcomes\.mjs/)
  for(const name of ['Read only the Neon usage key','Read only the existing PostHog project ingestion key','Collect database egress and publish aggregate health']){
    const body=section.slice(section.indexOf('- name: '+name)).split(/\n      - /)[0]
    assert.match(body,/if: always\(\)/)
  }
  assert.match(section,/node scripts\/ops\/egress-monitor.mjs --provider-only/)
})
