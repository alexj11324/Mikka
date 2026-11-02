import { connect } from 'node:net'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Daemon } from '../src/main'
import { MemoryServer } from '../src/server-link'
import { NoSandbox } from '../src/agents/sandbox'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { makeRepo } from './helpers'
import { createLogger } from '../src/log'
import { defaultRunPolicy } from '@mikka/protocol'
import { daemonTestMode } from '@mikka/protocol/repository'
import { test } from 'node:test'
test('actual daemon injects local authority and closes its own socket on stop', { timeout: 45000 }, async t => {
// This entry uses node:test, so it does not inherit vitest's isolated file-origin
// setting. The caller must opt in; production admission remains unchanged.
assert.ok(daemonTestMode(process.env), 'Temporary repository fixture requires NODE_ENV=test and MIKKA_TEST_MODE=1 outside production')
const root=mkdtempSync(join(tmpdir(),'pr161-host-')),bin=join(root,'cua-driver')
writeFileSync(bin,'#!/bin/sh\necho cua-driver 0.38.0\n');chmodSync(bin,0o700)
const oldPath=process.env.PATH
const restorePath=()=>{if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath}
t.after(()=>{restorePath();console.info(`Retained local computer daemon fixture: ${root}`)})
process.env.PATH=root+':'+(oldPath??'/usr/bin:/bin')
const device=randomUUID(),repoId=randomUUID(),botId=randomUUID(),workspaceId=randomUUID()
const server=new MemoryServer(device),repo=await makeRepo()
console.info(`Retained local computer daemon repository: ${repo}`)
server.addRepo(device,{repoId,name:'fixture',path:repo})
const authority={botId,workspaceId,ownerId:'owner',permission:'allow' as const,policyVersion:1}
const link=Object.assign(server.link(),{syncComputerReviews:async()=>[],localComputerAuthority:async()=>authority})
// This configuration-only fake CLI needs the same scoped admission contract
// as production, without granting any real tool action or invoking a driver.
link.prepareRunToolApproval=async(assignment,signal,check)=>{
 const gate=new ToolApprovalGate(assignment.runId,{
  isLive:currentRunId=>{
   if(currentRunId!==assignment.runId||signal.aborted)return false
   try{check();return true}catch{return false}
  },
 })
 const abort=()=>gate.revoke()
 gate.onRevoke(()=>signal.removeEventListener('abort',abort))
 if(signal.aborted)gate.revoke()
 else signal.addEventListener('abort',abort,{once:true})
 return gate
}
const runId=server.queueRun(device,{issueId:randomUUID(),repoId,baseBranch:'main',harness:'codex',prompt:'COMPUTER_CONFIG_TEST',localComputer:authority,policy:{...defaultRunPolicy(),permissions:{...defaultRunPolicy().permissions,computer_use:'allow'}}})
let endpoint = ''
const daemon=await new Daemon({dataDir:join(root,'daemon'),flavor:'dev',link,credential:'synthetic',agentSandbox:new NoSandbox(),harnesses:[{harness:'codex',installed:true,version:'fixture'}],harnessBinaries:{codex:resolve('test/fakes/fake-codex.mjs')},quotaSource:null,heartbeatMs:50,commandsWaitSeconds:1,log:createLogger({level:'silent'})}).start()
try {
 await daemon.syncWithServer()
 let text=''
 for(let i=0;i<200;i++){
   text=(server.streams.get(runId)??[]).filter((c:any)=>c.type==='text-delta').map((c:any)=>c.delta).join('')
   if(text.includes('computer'))break
   const run=server.runs.get(runId)
   assert.notEqual(run?.state,'failed',run?.completion?.report.summary ?? run?.patches.at(-1)?.error ?? 'Daemon failed before the adapter emitted its computer configuration')
   await new Promise(r=>setTimeout(r,25))
 }
 assert.ok(text.includes('computer'),'Daemon did not emit the adapter computer configuration before the deadline')
 const computer=JSON.parse(text).computer
 endpoint=computer.args[1]
 assert.equal(computer.command,process.execPath)
 assert.equal(computer.args[0],resolve('src/computer/proxy.mjs'))
 assert.match(computer.args[1],/^tcp:\/\/127\.0\.0\.1:[0-9]+$/)
 assert.match(computer.args[2],/^[a-f0-9]{64}$/)
 console.log(JSON.stringify({actualDaemon:true,actualCodexAdapter:true,syntheticHarness:true,localGrantInjected:true,driverNotExposed:true,runId}))
} finally { await daemon.stop();restorePath() }

const url=new URL(endpoint)
const refused=await new Promise<NodeJS.ErrnoException>((resolve,reject)=>{const socket=connect({host:url.hostname,port:Number(url.port)});socket.once('error',resolve);socket.once('connect',()=>{socket.destroy();reject(new Error('Local broker still listening after stop'))});socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('Broker close check timed out'))})})
assert.equal(refused.code,'ECONNREFUSED')
})
