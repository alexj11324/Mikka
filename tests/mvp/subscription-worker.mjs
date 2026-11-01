#!/usr/bin/env node
// Test-only private worker ABI; production subscription authorization remains real.
import { createInterface } from 'node:readline'
import assert from 'node:assert/strict'
import { MVP_SERVICES } from './isolated-env.mjs'
import { MVP_SUBSCRIPTION_MODEL } from './subscription.mjs'
const lines=createInterface({input:process.stdin})
let config
for await(const line of lines) {
  if(!config) {config=JSON.parse(line);continue}
  const request=JSON.parse(line)
  const send=value=>process.stdout.write(JSON.stringify({id:request.id,...value})+'\n')
  try {
    const target=new URL(config.databaseUrl)
    assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&target.pathname==='/mikka_e2e'&&!target.search&&!target.hash)
    assert.equal(config.infisicalOrigin,MVP_SERVICES)
    assert.equal(config.accessToken,'mvp-synthetic-access')
    assert.equal(config.scope.provider,'codex')
    assert.equal(request.revision,1)
    if(request.method==='prepare') send({result:{state:'connected',revision:1}})
    else if(request.method==='quota') send({result:{status:200,body:{plan_type:'plus',credits:{has_credits:false,unlimited:false},rate_limit:{primary_window:{used_percent:10,limit_window_seconds:18000,reset_at:Math.floor(Date.now()/1000)+18000}}}}})
    else if(request.method==='executeStream') {
      assert.equal(request.model,MVP_SUBSCRIPTION_MODEL)
      assert.equal(request.payload.model,MVP_SUBSCRIPTION_MODEL)
      const response=await fetch(`${MVP_SERVICES}/subscription/model`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request.payload),redirect:'error'})
      assert.equal(response.status,200)
      const decoder=new TextDecoder()
      for await(const bytes of response.body) send({chunk:decoder.decode(bytes,{stream:true})})
      const remaining=decoder.decode()
      if(remaining)send({chunk:remaining})
      send({result:{done:true}})
    } else throw Error('Unsupported fixture operation')
  } catch {send({error:'subscription_fixture_refused'})}
  break
}
lines.close()
