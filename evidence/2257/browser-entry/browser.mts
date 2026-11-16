import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { startBundledLoopback } from '../../apps/desktop/src/main/bundled-loopback'
import { continueInSystemBrowser } from '../../apps/desktop/test/browser-handoff.mjs'

export async function browserEntry(scope:any, dir:string, origin:string, record:any) {
  const home=await mkdtemp(join(dir,'browser-')), ca=join(dir,'ephemeral-ca.pem')
  const nss=join(home,'.pki/nssdb'), current=join(home,'.local/share/pki')
  await mkdir(nss,{recursive:true,mode:0o700}); await mkdir(current,{recursive:true,mode:0o700})
  await symlink(nss,join(current,'nssdb'),'dir')
  execFileSync('certutil',['-N','--empty-password','-d','sql:'+nss],{stdio:'ignore'})
  execFileSync('certutil',['-A','-n','Isolated community CA','-t','C,,','-i',ca,'-d','sql:'+nss],{stdio:'ignore'})
  const launchEnv=Object.fromEntries(['PATH','LANG','TMPDIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]!]))
  let browser,listener
  try{
    record('browser_nss_setup_pending_sandbox')
    browser=await chromium.launch({channel:'chrome',chromiumSandbox:true,env:{...launchEnv,HOME:home,NODE_EXTRA_CA_CERTS:ca}})
    record('real_system_chrome_with_sandbox',{version:browser.version()})
    const context=await browser.newContext({storageState:scope.owner.storageStatePath})
    const page=await context.newPage()
    const version=await page.goto(origin+'/mikka/api/version',{waitUntil:'domcontentloaded'})
    assert.equal(version?.status(),200);assert.equal((await version!.json()).build,process.env.E_RUN_SOURCE)
    record('browser_trusts_target_revision')
    const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url')
    const challenge=createHash('sha256').update(verifier).digest('base64url')
    const code=Promise.withResolvers<string>()
    listener=await startBundledLoopback(state,code.resolve)
    const begin=await fetch(origin+'/mikka/api/desktop/begin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state,challenge,callback:listener.callback})})
    assert.ok(begin.ok)
    const url=new URL('/mikka/sign-in',origin)
    url.search=new URLSearchParams({desktop:'1',desktop_state:state,desktop_next:'/',desktop_callback:listener.callback,continue:'google'}).toString()
    record('normal_begin_precedes_real_continue')
    await continueInSystemBrowser(page,url.href)
    record('actual_browser_continue_and_loopback_return')
    const exchange=await fetch(origin+'/mikka/api/desktop/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state,code:await code.promise,verifier,client:'bundled'})})
    assert.ok(exchange.ok);const result=await exchange.json()
    assert.equal(result.user.id,scope.owner.userId);assert.ok(result.session.id&&result.token)
    await scope.recordResource({type:'session',id:result.session.id,ownerId:scope.owner.userId})
    record('community_pkce_exchange_owner_identity',{actualSubscription:false,actualGoogleOAuth:false,packagedDesktop:false})
  }finally{listener?.close();await browser?.close();await rm(home,{recursive:true,force:true})}
}
