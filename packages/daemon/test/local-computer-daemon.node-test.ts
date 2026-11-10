import { connect } from 'node:net'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Daemon } from '../src/main'
import { ComputerBroker } from '../src/computer/broker.mjs'
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
// detect it once for concurrent callers, listen on the local broker and
// announce the capability in a forced heartbeat (the periodic one is a
// minute away), so a run claimed afterwards already gets the request-only
// proxy. A later replacement must retire or rewire the broker.
test('a driver installed after start is wired and revalidated without a restart', { timeout: 90000 }, async t => {
const root=mkdtempSync(join(tmpdir(),'pr161-late-'))
const previousDriver=process.env.MIKKA_CUA_DRIVER
delete process.env.MIKKA_CUA_DRIVER
t.after(()=>{if(previousDriver===undefined)delete process.env.MIKKA_CUA_DRIVER;else process.env.MIKKA_CUA_DRIVER=previousDriver})
if(await detectComputerDriver()){t.skip('a pinned driver is already installed; the late-install path cannot be isolated');return}
const binary=join(root,'cua-driver'),countFile=join(root,'version-count')
const pinned=(extra='')=>`#!/bin/sh\nif [ "$1" = "--version" ]; then echo x >> '${countFile}'; echo "cua-driver 0.38.0"; exit 0; fi\nexit 0\n${extra}`
writeFileSync(binary,pinned());chmodSync(binary,0o700)
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
const daemon=await new Daemon({dataDir,flavor:'dev',link,credential:'synthetic',agentSandbox:new NoSandbox(),harnesses:[{harness:'codex',installed:true,version:'fixture'}],harnessBinaries:{codex:resolve('test/fakes/fake-codex.mjs')},quotaSource:null,heartbeatMs:60000,commandsWaitSeconds:1,log:createLogger({level:'silent'})}).start()
t.after(()=>daemon.stop())
await daemon.syncWithServer()
const deviceId=daemon.status().deviceId
assert.ok(deviceId,'the daemon registered before the late install')
assert.equal(server.devices.get(deviceId)?.lastHeartbeat?.computerUse?.installed,false,'no driver was installed at registration')

const waitInstalled=async(expected:boolean)=>{
 for(let i=0;i<40;i++){
  if(server.devices.get(deviceId)?.lastHeartbeat?.computerUse?.installed===expected)return
  await new Promise(r=>setTimeout(r,50))
 }
 assert.equal(server.devices.get(deviceId)?.lastHeartbeat?.computerUse?.installed,expected,`the forced heartbeat must report installed=${expected}`)
}
const computerForRun=async(prompt:string)=>{
 const runId=server.queueRun(device,{issueId:randomUUID(),repoId,baseBranch:'main',harness:'codex',prompt,localComputer:authority,policy:{...defaultRunPolicy(),permissions:{...defaultRunPolicy().permissions,computer_use:'allow'}}})
 await daemon.syncWithServer()
 let text=''
 for(let i=0;i<400;i++){
  text=(server.streams.get(runId)??[]).filter((c:any)=>c.type==='text-delta').map((c:any)=>c.delta).join('')
  if(text.includes('computer'))break
  const run=server.runs.get(runId)
  assert.notEqual(run?.state,'failed',run?.completion?.report.summary??run?.patches.at(-1)?.error??'Daemon failed before the adapter emitted its computer configuration')
  await new Promise(r=>setTimeout(r,25))
 }
 assert.ok(text.includes('computer'),`the daemon run emitted its computer configuration (state=${server.runs.get(runId)?.state}, patch=${JSON.stringify(server.runs.get(runId)?.patches.at(-1))})`)
 return JSON.parse(text).computer
}

// The person installs 0.38.0; the daemon is not restarted. Two concurrent
// status calls share one inspection (the counter proves it) and both see the
// broker already announced by the forced heartbeat.
process.env.MIKKA_CUA_DRIVER=binary
const client=await connectDaemonInDataDir(dataDir,{name:'late-driver-test',version:'0'})
t.after(()=>client.close())
const [first,second]=await Promise.all([client.request('computer.permissions'),client.request('computer.permissions')])
assert.equal(first.installed,true,'the doctor RPC detected the new driver')
assert.equal(second.version,'cua-driver 0.38.0')
assert.equal(readFileSync(countFile,'utf8').trim().split('\n').filter(Boolean).length,1,'concurrent status calls inspect the driver once')
await waitInstalled(true)
const lateComputer=await computerForRun('COMPUTER_CONFIG_TEST')
assert.ok(lateComputer?.command,'the late broker and the run grant are both live')
assert.equal(lateComputer.args[0],resolve('src/computer/proxy.mjs'))

// A downgrade replaces the binary under the same path: the wired broker is
// retired, the capability is announced false and new runs get no proxy.
writeFileSync(binary,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cua-driver 0.23.2"; exit 0; fi\nexit 0\n');chmodSync(binary,0o700)
const downgraded=await client.request('computer.permissions')
assert.equal(downgraded.installed,false,'a downgrade retires the capability')
assert.equal(downgraded.probe.status,'binary_version')
assert.match(downgraded.version??'',/0\.23\.2/)
await waitInstalled(false)
assert.equal(await computerForRun('COMPUTER_CONFIG_TEST'),null,'no broker means no computer config for a new run')

// A fresh pinned binary at the same path rewires the broker and the
// capability comes back without a restart.
writeFileSync(binary,pinned('# rewired\n'));chmodSync(binary,0o700)
const rewired=await client.request('computer.permissions')
assert.equal(rewired.installed,true,'a new pinned binary is rewired')
assert.equal(rewired.version,'cua-driver 0.38.0')
await waitInstalled(true)
const rewiredComputer=await computerForRun('COMPUTER_CONFIG_TEST')
assert.ok(rewiredComputer?.command,'the rewired broker serves new runs')
console.log(JSON.stringify({lateDriverWithoutRestart:true,revalidated:true,rewired:true}))
})

// A driver that appears with no review transport cannot be served by a run.
// The RPC fails instead of reporting Ready, and the heartbeat stays false.
test('a driver without a review transport fails the status RPC instead of reporting Ready', { timeout: 30000 }, async t => {
const root=mkdtempSync(join(tmpdir(),'pr161-notransport-'))
const previousDriver=process.env.MIKKA_CUA_DRIVER
const binary=join(root,'cua-driver')
writeFileSync(binary,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cua-driver 0.38.0"; exit 0; fi\nexit 0\n');chmodSync(binary,0o700)
process.env.MIKKA_CUA_DRIVER=binary
t.after(()=>{if(previousDriver===undefined)delete process.env.MIKKA_CUA_DRIVER;else process.env.MIKKA_CUA_DRIVER=previousDriver})
const device=randomUUID(),repoId=randomUUID()
const server=new MemoryServer(device),repo=await makeRepo()
server.addRepo(device,{repoId,name:'no-transport',path:repo})
const link=server.link()
const dataDir=join(root,'daemon')
const daemon=await new Daemon({dataDir,flavor:'dev',link,credential:'synthetic',agentSandbox:new NoSandbox(),harnesses:[{harness:'codex',installed:true,version:'fixture'}],harnessBinaries:{codex:resolve('test/fakes/fake-codex.mjs')},quotaSource:null,heartbeatMs:60000,commandsWaitSeconds:1,log:createLogger({level:'silent'})}).start()
t.after(()=>daemon.stop())
await daemon.syncWithServer()
const deviceId=daemon.status().deviceId
assert.ok(deviceId)
assert.equal(server.devices.get(deviceId)?.lastHeartbeat?.computerUse?.installed,false,'no broker means installed=false')
const client=await connectDaemonInDataDir(dataDir,{name:'no-transport-test',version:'0'})
try{
 await assert.rejects(()=>client.request('computer.permissions'),/broker unavailable/)
}finally{client.close()}
})

// A stop that races a binding broker must not leave a TCP listener behind.
test('a stop during a delayed broker listen leaves no listener', { timeout: 30000 }, async t => {
const root=mkdtempSync(join(tmpdir(),'pr161-stop-'))
const previousDriver=process.env.MIKKA_CUA_DRIVER
delete process.env.MIKKA_CUA_DRIVER
t.after(()=>{if(previousDriver===undefined)delete process.env.MIKKA_CUA_DRIVER;else process.env.MIKKA_CUA_DRIVER=previousDriver})
const binary=join(root,'cua-driver')
writeFileSync(binary,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cua-driver 0.38.0"; exit 0; fi\nexit 0\n');chmodSync(binary,0o700)
const device=randomUUID(),repoId=randomUUID()
const server=new MemoryServer(device),repo=await makeRepo()
server.addRepo(device,{repoId,name:'stop-race',path:repo})
const link=Object.assign(server.link(),{syncComputerReviews:async()=>[]})
const dataDir=join(root,'daemon')
const daemon=await new Daemon({dataDir,flavor:'dev',link,credential:'synthetic',agentSandbox:new NoSandbox(),harnesses:[{harness:'codex',installed:true,version:'fixture'}],harnessBinaries:{codex:resolve('test/fakes/fake-codex.mjs')},quotaSource:null,heartbeatMs:60000,commandsWaitSeconds:1,log:createLogger({level:'silent'})}).start()
t.after(()=>daemon.stop())
await daemon.syncWithServer()
process.env.MIKKA_CUA_DRIVER=binary
const originalListen=ComputerBroker.prototype.listen
const started:{broker?:ComputerBroker}={}
ComputerBroker.prototype.listen=async function(){
 started.broker=this
 await new Promise(r=>setTimeout(r,500))
 return originalListen.call(this)
}
t.after(()=>{ComputerBroker.prototype.listen=originalListen})
const client=await connectDaemonInDataDir(dataDir,{name:'stop-race-test',version:'0'})
const pending=client.request('computer.permissions').catch(()=>undefined)
await new Promise(r=>setTimeout(r,100))
await daemon.stop()
// The in-flight RPC may never settle once its socket is closed; the listener
// is what this test observes, not the client's response.
void pending
client.close()
assert.ok(started.broker,'the late setup reached listen')
// broker.d.mts keeps the live socket field internal; listen() rewrites it for
// tcp, so this white-box check reads the post-listen value from the instance.
const url=new URL((started.broker as ComputerBroker & {socketPath:string}).socketPath)
const refused=await new Promise<NodeJS.ErrnoException>((resolve,reject)=>{
 const socket=connect({host:url.hostname,port:Number(url.port)})
 socket.once('error',resolve)
 socket.once('connect',()=>{socket.destroy();reject(new Error('the broker listener survived stop'))})
 socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('stop listener check timed out'))})
})
assert.equal(refused.code,'ECONNREFUSED')
})
