import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runtimeMonitorOwner } from './runtime-monitor-owner.mjs'

const product='b'.repeat(40)
test('the serving runtime owns the monitor; an unreadable or Vercel authority keeps the Vercel checks',async()=>{
  assert.deepEqual(await runtimeMonitorOwner({authority:async()=>({provider:'cloudflare',sha:product})}),
    {runtime:'cloudflare',product,reason:'serving_cloudflare'})
  assert.deepEqual(await runtimeMonitorOwner({authority:async()=>({provider:'vercel',sha:product})}),{runtime:'vercel',reason:'serving_vercel'})
  assert.deepEqual(await runtimeMonitorOwner({authority:async()=>{throw Error('dns')}}),{runtime:'vercel',reason:'authority_unreadable'})
})
test('the original schedule keeps Neon, PostHog and its provider-only accounting even after source handoff',async()=>{
  const file=await readFile(new URL('../../.github/workflows/production-smoke.yml',import.meta.url),'utf8')
  const section=file.slice(file.indexOf('  deployment-comparison:'))
  for(const step of ['Read the existing Vercel token through Infisical workload identity','Compare fixed production deployment windows','Collect production request outcomes']){
    const body=section.slice(section.indexOf('- name: '+step)).split(/\n      - /)[0]
    assert.match(body,/steps.runtime.outputs.runtime != 'cloudflare'/)
  }
  for(const name of ['Read only the Neon usage key','Read only the existing PostHog project ingestion key','Collect database egress and publish aggregate health']){
    const body=section.slice(section.indexOf('- name: '+name)).split(/\n      - /)[0]
    assert.match(body,/if: always\(\)/)
  }
  assert.match(section,/node scripts\/ops\/egress-monitor.mjs --provider-only/)
})
