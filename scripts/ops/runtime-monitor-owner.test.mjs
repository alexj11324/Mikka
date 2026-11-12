import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { runtimeMonitorOwner } from './runtime-monitor-owner.mjs'

const first=Date.UTC(2026,10,12,0),last=first+8*900000,effective=last+2*900000
const product='b'.repeat(40),hash='c'.repeat(64),iso=n=>new Date(n).toISOString()
const evidence=Object.fromEntries(['scheduledCadence','runtimeComparison','requestSlis','pressureDelivery','filesystemDelivery','queryAttribution']
  .map((name,i)=>[name,{url:'https://github.com/alexj11324/mikka-cloud/issues/4#issuecomment-'+(100+i),sha256:hash}]))
const record={schema:'mikka.runtime-monitor-milestone.v1',promotion:'532-'+hash,firstQuarter:iso(first),
  lastQuarter:iso(last),effectiveAt:iso(effective),evidence}
const issue='https://api.github.com/repos/alexj11324/Mikka/issues/1951'
function evaluate(change={}){
  const m={...record,...change.m},body='MIKKA_RUNTIME_MONITOR_MILESTONE_V1\n'+JSON.stringify(m)
  const digest=createHash('sha256').update(body).digest('hex'),pin='<!-- MIKKA_RUNTIME_MONITOR_MILESTONE 143-'+(change.digest??digest)+' -->'
  return runtimeMonitorOwner({now:effective+900000,windowStart:change.start??effective,
    authority:async()=>({provider:change.provider??'cloudflare',sha:product}),
    promotion:async s=>{assert.equal(s,record.promotion);if(change.rollback)throw Error('rollback');return {product,verifiedAt:iso(first-1000)}},
    verifiedPublisher:change.verifiedPublisher,
    read:async path=>{
      if(path==='/issues/1951')return {number:1951,url:issue,body:change.pin??pin}
      if(path==='/issues/comments/143')return {id:143,issue_url:issue,created_at:iso(last+1000),body,author_association:change.member??'COLLABORATOR',user:{login:'release-maintainer',id:6}}
      assert.equal(path,'/collaborators/release-maintainer/permission')
      return {permission:change.role??'write',user:{id:change.id??6}}
    }})
}
test('only an effective, write-authorized, complete milestone on the same still-serving release can retire Vercel reads',async()=>{
  const positive=await evaluate()
  assert.match(positive.milestone,/^143-[a-f0-9]{64}$/)
  assert.deepEqual({...positive,milestone:undefined},{runtime:'cloudflare',promotion:record.promotion,milestone:undefined,observedUntil:last,reason:'verified_handoff'})
  for(const c of [{verifiedPublisher:async()=>false},{provider:'vercel'},{start:effective-1},{role:'read'},{id:7},{member:'CONTRIBUTOR'},
    {digest:'3'.repeat(64)},{pin:''},{rollback:true},{m:{effectiveAt:iso(last)}},{m:{firstQuarter:iso(first+900000)}},
    {m:{evidence:{...evidence,pressureDelivery:{url:'https://other.invalid/',sha256:hash}}}}])
    assert.equal((await evaluate(c)).runtime,'vercel')
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
