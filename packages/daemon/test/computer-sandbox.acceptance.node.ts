import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { SandboxRuntime } from '../src/agents/sandbox'
import { ComputerBroker } from '../src/computer/broker.mjs'

test('real Linux isolation reaches only the granted computer broker through the per-run proxy', { timeout: 60000 }, async () => {
 const dir=await mkdtemp(join(tmpdir(),'cua-sandbox-'))
 const sandbox=new SandboxRuntime()
 let calls=0, foreignCalls=0
 const broker=new ComputerBroker({transport:'tcp',socketPath:join(dir,'unused'),driver:{installed:true,path:'/fixture',version:'fixture',fingerprint:'a'.repeat(64)},permitted:()=>true,execute:async()=>{calls++;return {content:[{type:'text',text:'executed'}]}}})
 const foreign=new ComputerBroker({transport:'tcp',socketPath:join(dir,'foreign'),driver:{installed:true,path:'/fixture',version:'fixture',fingerprint:'b'.repeat(64)},permitted:()=>true,execute:async()=>{foreignCalls++;return {content:[]}}})
 try {
  await broker.listen();await foreign.listen();await sandbox.probe()
  const grant=broker.spec('run','allow')!
  const domain=new URL(grant.socketPath).host
  const foreignGrant=foreign.spec('foreign','allow')!
  for(const [selected,domains,allowed] of [[grant,[domain],true],[grant,[],false],[foreignGrant,[domain],false]] as const) {
   const wrapped=await sandbox.wrap([process.execPath,resolve('src/computer/proxy.mjs'),selected.socketPath,selected.token],{allowWrite:[dir],allowDomains:[...domains]})
   const child=spawn('/bin/sh',['-c',wrapped.command],{env:{...process.env,MIKKA_COMPUTER_SANDBOX_PROXY:'1'},stdio:['pipe','pipe','pipe']})
   let stderr='';child.stderr.on('data',b=>stderr+=String(b))
   const lines=createInterface({input:child.stdout})
   const reply=new Promise<any>((resolve,reject)=>{lines.once('line',line=>resolve(JSON.parse(line)));child.once('exit',code=>reject(new Error(`Proxy exited ${code}: ${stderr}`)))})
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_desktop_state',arguments:{}}})+'\n')
   try {
   const result=await reply
   if(allowed){assert.equal(result.result.isError,undefined);assert.equal(result.result.content[0].text,'executed')}
   else assert.equal(result.result.isError,true)
   } finally { child.stdin.end();lines.close();child.kill();wrapped.release() }
  }
  assert.equal(calls,1);assert.equal(foreignCalls,0)
 } finally {await foreign.close();await broker.close();await sandbox.reset();await rm(dir,{recursive:true,force:true})}
})
