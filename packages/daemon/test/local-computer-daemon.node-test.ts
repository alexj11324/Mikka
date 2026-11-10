import { connect } from 'node:net'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Daemon } from '../src/main'
import { detectComputerDriver } from '../src/computer/driver.mjs'
import { connectDaemonInDataDir } from '../src/rpc/client'
import { MemoryServer } from '../src/server-link'
import { NoSandbox } from '../src/agents/sandbox'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { makeRepo } from './helpers'
import { createLogger } from '../src/log'
import { defaultRunPolicy } from '@mikka/protocol'
import { daemonTestMode } from '@mikka/protocol/repository'
import { test } from 'node:test'
import { compileFixture, fixtureFile, startFixture, waitFile } from './macos-fixture.ts'
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

// macOS only, and only where the pinned 0.38.0 driver and its TCC grants are
// present. It runs on a dedicated Mac, never on hosted CI: the fixture app and
// the real driver prove all four actions through the proxy the daemon injected.
const macDriverBinary = process.env.MIKKA_CUA_TEST_BINARY
test('macOS real driver: screenshot, click, type and scroll through the daemon-injected proxy', { skip: process.platform !== 'darwin' || !macDriverBinary, timeout: 180000 }, async t => {
const root=mkdtempSync(join(tmpdir(),'pr161-macos-'))
const previousDriver=process.env.MIKKA_CUA_DRIVER
process.env.MIKKA_CUA_DRIVER=macDriverBinary
t.after(()=>{if(previousDriver===undefined)delete process.env.MIKKA_CUA_DRIVER;else process.env.MIKKA_CUA_DRIVER=previousDriver})
const fixtureBinary=await compileFixture(root)
const fixture=await startFixture(fixtureBinary,'all')
t.after(()=>fixture.child.kill())
const marker=`Mikka daemon acceptance ${randomUUID()}`
const calls=[
 {name:'get_desktop_state',arguments:{}},
 {name:'click',arguments:fixture.points.button},
 {name:'type_text',arguments:{text:marker}},
 {name:'press_key',arguments:{key:'enter'}},
 {name:'scroll',arguments:{direction:'down',amount:5,x:fixture.points.scroll.x,y:fixture.points.scroll.y}},
 {name:'get_desktop_state',arguments:{}},
]
const device=randomUUID(),repoId=randomUUID(),botId=randomUUID(),workspaceId=randomUUID()
const server=new MemoryServer(device),repo=await makeRepo()
server.addRepo(device,{repoId,name:'macos-fixture',path:repo})
const authority={botId,workspaceId,ownerId:'owner',permission:'allow' as const,policyVersion:1}
const link=Object.assign(server.link(),{syncComputerReviews:async()=>[],localComputerAuthority:async()=>authority})
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
const runId=server.queueRun(device,{issueId:randomUUID(),repoId,baseBranch:'main',harness:'codex',prompt:`COMPUTER_ACTIONS_TEST ${JSON.stringify(calls)}`,localComputer:authority,policy:{...defaultRunPolicy(),permissions:{...defaultRunPolicy().permissions,computer_use:'allow'}}})
const daemon=await new Daemon({dataDir:join(root,'daemon'),flavor:'dev',link,credential:'synthetic',agentSandbox:new NoSandbox(),harnesses:[{harness:'codex',installed:true,version:'fixture'}],harnessBinaries:{codex:resolve('test/fakes/fake-codex.mjs')},quotaSource:null,heartbeatMs:50,commandsWaitSeconds:1,log:createLogger({level:'silent'})}).start()
t.after(()=>daemon.stop())
await daemon.syncWithServer()
let text=''
for(let i=0;i<600;i++){
 text=(server.streams.get(runId)??[]).filter((c:any)=>c.type==='text-delta').map((c:any)=>c.delta).join('')
 if(text.includes('computerResults'))break
 const run=server.runs.get(runId)
 assert.notEqual(run?.state,'failed',run?.completion?.report.summary??run?.patches.at(-1)?.error??'Daemon failed before the harness reported the computer actions')
 await new Promise(r=>setTimeout(r,50))
}
assert.ok(text.includes('computerResults'),'the daemon run emitted the four-action results through the injected proxy')
const parsed=JSON.parse(text.slice(text.indexOf('{"computerResults"')))
assert.deepEqual(parsed.computerResults.map((result:any)=>result.name),calls.map(call=>call.name))
for(const result of parsed.computerResults)assert.equal(result.isError,false,`${result.name} through the real proxy`)
for(const shot of parsed.computerResults.filter((result:any)=>result.name==='get_desktop_state')){
 assert.ok(shot.imageBytes>0,'screenshot content returned')
 assert.ok(shot.width>0&&shot.height>0,'screenshot has pixel dimensions')
}
assert.equal(await waitFile(fixtureFile(fixture,'click')),'clicked','the real click reached the fixture button')
assert.equal(await waitFile(fixtureFile(fixture,'type')),marker,'the fixture text field received exactly the marker on enter')
assert.ok(Number(await waitFile(fixtureFile(fixture,'scroll')))>0,'the real scroll changed the fixture content offset')
console.log(JSON.stringify({macosDaemonAcceptance:true,actions:calls.map(call=>call.name)}))
})

// 0.38.0 installed while the daemon keeps running: the doctor RPC must
// detect it, listen on the local broker and announce the capability, so a run
// claimed afterwards already gets the request-only proxy. No restart.
test('a driver installed after start is wired and announced without a restart', { timeout: 60000 }, async t => {
const root=mkdtempSync(join(tmpdir(),'pr161-late-'))
const previousDriver=process.env.MIKKA_CUA_DRIVER,previousPath=process.env.PATH
delete process.env.MIKKA_CUA_DRIVER
t.after(()=>{if(previousDriver===undefined)delete process.env.MIKKA_CUA_DRIVER;else process.env.MIKKA_CUA_DRIVER=previousDriver;if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath})
if(await detectComputerDriver()){t.skip('a pinned driver is already installed; the late-install path cannot be isolated');return}
const lateBin=join(root,'late-bin');mkdirSync(lateBin)
const device=randomUUID(),repoId=randomUUID(),botId=randomUUID(),workspaceId=randomUUID()
const server=new MemoryServer(device),repo=await makeRepo()
server.addRepo(device,{repoId,name:'late-driver',path:repo})
const authority={botId,workspaceId,ownerId:'owner',permission:'allow' as const,policyVersion:1}
const link=Object.assign(server.link(),{syncComputerReviews:async()=>[],localComputerAuthority:async()=>authority})
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
const dataDir=join(root,'daemon')
const daemon=await new Daemon({dataDir,flavor:'dev',link,credential:'synthetic',agentSandbox:new NoSandbox(),harnesses:[{harness:'codex',installed:true,version:'fixture'}],harnessBinaries:{codex:resolve('test/fakes/fake-codex.mjs')},quotaSource:null,heartbeatMs:50,commandsWaitSeconds:1,log:createLogger({level:'silent'})}).start()
t.after(()=>daemon.stop())
await daemon.syncWithServer()
const deviceId=daemon.status().deviceId
assert.ok(deviceId,'the daemon registered before the late install')
assert.equal(server.devices.get(deviceId)?.lastHeartbeat?.computerUse?.installed,false,'no driver was installed at registration')

// The person installs 0.38.0; the daemon is not restarted.
const binary=join(lateBin,'cua-driver')
writeFileSync(binary,'#!/bin/sh\necho cua-driver 0.38.0\n');chmodSync(binary,0o700)
process.env.PATH=`${lateBin}:${previousPath??''}`
const client=await connectDaemonInDataDir(dataDir,{name:'late-driver-test',version:'0'})
try{
 const report=await client.request('computer.permissions')
 assert.equal(report.installed,true,'the doctor RPC detected the new driver')
 assert.equal(report.version,'cua-driver 0.38.0')
}finally{client.close()}

let announced=false
for(let i=0;i<200;i++){
 if(server.devices.get(deviceId)?.lastHeartbeat?.computerUse?.installed===true){announced=true;break}
 await new Promise(r=>setTimeout(r,25))
}
assert.ok(announced,'the next heartbeat carries installed=true so the claim route grants localComputer')

const runId=server.queueRun(device,{issueId:randomUUID(),repoId,baseBranch:'main',harness:'codex',prompt:'COMPUTER_CONFIG_TEST',localComputer:authority,policy:{...defaultRunPolicy(),permissions:{...defaultRunPolicy().permissions,computer_use:'allow'}}})
await daemon.syncWithServer()
let text=''
for(let i=0;i<400;i++){
 text=(server.streams.get(runId)??[]).filter((c:any)=>c.type==='text-delta').map((c:any)=>c.delta).join('')
 if(text.includes('computer'))break
 const run=server.runs.get(runId)
 assert.notEqual(run?.state,'failed',run?.completion?.report.summary??run?.patches.at(-1)?.error??'Daemon failed before the adapter emitted its computer configuration')
 await new Promise(r=>setTimeout(r,25))
}
assert.ok(text.includes('computer'),'a run claimed after the late install got the proxy')
const computer=JSON.parse(text).computer
assert.ok(computer?.command,'the late broker and the run grant are both live')
assert.equal(computer.args[0],resolve('src/computer/proxy.mjs'))
console.log(JSON.stringify({lateDriverWithoutRestart:true,runId}))
})
