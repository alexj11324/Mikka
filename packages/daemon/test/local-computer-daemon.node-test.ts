import { connect } from 'node:net'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Daemon } from '../src/main'
import { MemoryServer } from '../src/server-link'
import { NoSandbox } from '../src/agents/sandbox'
import { makeRepo, cleanupTempDirs } from './helpers'
import { createLogger } from '../src/log'
import { defaultRunPolicy } from '@mikka/protocol'
import { test } from 'node:test'
test('actual daemon injects local authority and closes its own socket on stop', { timeout: 45000 }, async t => {
const root=mkdtempSync(join(tmpdir(),'pr161-host-')),bin=join(root,'cua-driver')
writeFileSync(bin,'#!/bin/sh\necho cua-driver 0.38.0\n');chmodSync(bin,0o700)
const oldPath=process.env.PATH;t.after(()=>{process.env.PATH=oldPath;cleanupTempDirs();rmSync(root,{recursive:true,force:true})});process.env.PATH=root+':'+oldPath
const device=randomUUID(),repoId=randomUUID(),botId=randomUUID(),workspaceId=randomUUID()
const server=new MemoryServer(device),repo=await makeRepo()
server.addRepo(device,{repoId,name:'fixture',path:repo})
const authority={botId,workspaceId,ownerId:'owner',permission:'allow' as const,policyVersion:1}
const link=Object.assign(server.link(),{syncComputerReviews:async()=>[],localComputerAuthority:async()=>authority})
const runId=server.queueRun(device,{issueId:randomUUID(),repoId,baseBranch:'main',harness:'codex',prompt:'COMPUTER_CONFIG_TEST',localComputer:authority,policy:{...defaultRunPolicy(),permissions:{...defaultRunPolicy().permissions,computer_use:'allow'}}})
let endpoint = ''
const daemon=await new Daemon({dataDir:join(root,'daemon'),flavor:'dev',link,credential:'synthetic',agentSandbox:new NoSandbox(),harnesses:[{harness:'codex',installed:true,version:'fixture'}],harnessBinaries:{codex:resolve('test/fakes/fake-codex.mjs')},quotaSource:null,heartbeatMs:50,commandsWaitSeconds:1,log:createLogger({level:'silent'})}).start()
try {
 await daemon.syncWithServer()
 let text=''
 for(let i=0;i<200;i++){
   text=(server.streams.get(runId)??[]).filter((c:any)=>c.type==='text-delta').map((c:any)=>c.delta).join('')
   if(text.includes('computer'))break
   await new Promise(r=>setTimeout(r,25))
 }
 const computer=JSON.parse(text).computer
 endpoint=computer.args[1]
 assert.equal(computer.command,process.execPath)
 assert.equal(computer.args[0],resolve('src/computer/proxy.mjs'))
 assert.match(computer.args[1],/^tcp:\/\/127\.0\.0\.1:[0-9]+$/)
 assert.match(computer.args[2],/^[a-f0-9]{64}$/)
 console.log(JSON.stringify({actualDaemon:true,actualCodexAdapter:true,syntheticHarness:true,localGrantInjected:true,driverNotExposed:true,runId}))
} finally { await daemon.stop();process.env.PATH=oldPath }

const url=new URL(endpoint)
const refused=await new Promise<NodeJS.ErrnoException>((resolve,reject)=>{const socket=connect({host:url.hostname,port:Number(url.port)});socket.once('error',resolve);socket.once('connect',()=>{socket.destroy();reject(new Error('Local broker still listening after stop'))});socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('Broker close check timed out'))})})
assert.equal(refused.code,'ECONNREFUSED')
})
