// Agent Linux browser transport only. Official and Mikka HTTPS routes are
// intercepted locally; no provider/vault/account request is made.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from '@playwright/test'
import { enrollmentHandoffHTTP, enrollmentHandoffPage } from '../lib/subscription-enrollment-handoff.ts'
import { startCallbackRelay } from '../scripts/byos-claude-loopback-relay.mjs'

test('browser fragment handoff and real loopback redirect preserve exact completion without logging secrets', {timeout:30000}, async()=>{
  const origin='https://mikka-fixture123-mikka-dev.vercel.app', receiver=origin+'/mikka/api/subscriptions/enrollments/handoff'
  const id='20000000-0000-4000-8000-000000000001', handoffKey='h'.repeat(43), state='s'.repeat(43)
  const authorize=new URL('https://claude.ai/oauth/authorize');for(const [k,v] of Object.entries({code:'true',response_type:'code',scope:'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',code_challenge:'c'.repeat(43),client_id:'9d1c250a-e61b-44d9-88ed-5944d1962f5e',redirect_uri:'http://localhost:54545/callback',code_challenge_method:'S256',state}))authorize.searchParams.set(k,v)
  const calls=[],requests=[]
  const post=enrollmentHandoffHTTP({enabled:()=>true,client:()=>({async handoff(body){calls.push(body);return {id,provider:'claude',state:'pending_unbound',taskUseAllowed:false}}})})
  let browser,relay,stage='start'
  try{
    relay=await startCallbackRelay(receiver,state)
    browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']})
    const page=await browser.newPage();page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(5000)
    await page.route('**/*',route=>route.abort())
    await page.route('https://claude.ai/oauth/authorize**',route=>route.fulfill({status:200,contentType:'text/html',body:'<body>Synthetic official authorization</body>'}))
    await page.route(receiver+'**',async route=>{
      const req=route.request();requests.push(req.url())
      const request=new Request(req.url(),{method:req.method(),headers:req.headers(),...(req.method()==='POST'?{body:req.postData()}: {})})
      const response=req.method()==='GET'?enrollmentHandoffPage(request,true):await post(request)
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
    })
    const launch=new URL(receiver);launch.hash=new URLSearchParams({id,provider:'claude',handoffKey,authorizationUrl:authorize.href}).toString()
    stage='initial_authorization_navigation';await page.goto(launch.href);await page.waitForURL('https://claude.ai/oauth/authorize**')
    const callback=`http://localhost:54545/callback?code=synthetic-code&state=${state}`
    // Playwright routes only the first request in a redirect chain. Exercise
    // the real loopback response separately, then apply its exact Location in
    // the browser, keeping every HTTPS destination intercepted locally.
    stage='loopback_redirect';const redirect=await fetch(callback,{redirect:'manual'});assert.equal(redirect.status,303)
    stage='completion_navigation';await page.goto(redirect.headers.get('location'))
    await page.waitForFunction(()=>document.body.textContent.includes('Authorization saved on Mikka'))
    assert.deepEqual(calls,[{id,provider:'claude',handoffKey,callbackUrl:callback}])
    assert.equal(page.url(),receiver)
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('mikka.byos.handoff.v1')),null)
    assert.ok(requests.every(value=>!value.includes('synthetic-code')&&!value.includes(handoffKey)), 'private values entered server request URLs')
    // A repeat browser callback has no stored capability and cannot POST again.
    stage='replay';const replay=await fetch(callback,{redirect:'manual'});assert.equal(replay.status,303);await page.goto(replay.headers.get('location'));await page.waitForFunction(()=>document.body.textContent.includes('handoff refused or expired'))
    assert.equal(calls.length,1)
  }catch{throw new Error('handoff_browser_failed_at_'+stage)}finally{await browser?.close();if(relay){relay.closeAllConnections();await new Promise(resolve=>relay.close(resolve))}}
})
