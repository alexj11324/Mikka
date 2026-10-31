import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { RunContext } from '../src/agents/run-context'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { policySnapshotHash, verifyPolicySnapshot } from '@mikka/protocol/node-policy-snapshot'
import { POLICY_SNAPSHOT_TTL_MS, policySnapshotMessage, type PolicyDistributionContext, type PolicySnapshotPayload } from '@mikka/protocol/policy-snapshot'
import { HttpServerLink } from '../src/server-link-http'
import { Daemon } from '../src/main'
import { writeJsonAtomic } from '../src/fs-util'
import { daemonPaths } from '../src/paths'
import { RunJournal } from '../src/runs/journal'
import { RunSupervisor, type SupervisorDeps } from '../src/runs/supervisor'
import { createLogger } from '../src/log'
import { cleanupTempDirs, tempDir, makeRepo, waitFor } from './helpers'

const issuer = 'http://127.0.0.1:19723/mikka'
const {privateKey,publicKey} = generateKeyPairSync('ed25519')
const der = publicKey.export({format:'der',type:'spki'})
const context: PolicyDistributionContext = {version:1,algorithm:'Ed25519',keyId:createHash('sha256').update(der).digest('hex'),publicKey:der.toString('base64url'),issuer,ownerId:'owner-1',deviceId:'dev-1',runId:'run-1',revision:'a'.repeat(64),scope:{workspaceIds:[],hierarchy:null},required:true}
function fixture(now=Date.now()) {
  const policy={...defaultRunPolicy(),readOnly:true,permissions:{...defaultRunPolicy().permissions,git_push:'deny' as const,computer_use:'deny' as const}}
  const payload: PolicySnapshotPayload={version:1,issuer,ownerId:context.ownerId,deviceId:context.deviceId,runId:context.runId,revision:context.revision,policyHash:policySnapshotHash(policy),scope:context.scope,policy,issuedAt:now,expiresAt:now+POLICY_SNAPSHOT_TTL_MS}
  const snapshot={algorithm:'Ed25519' as const,keyId:context.keyId,payload,signature:sign(null,policySnapshotMessage(payload),privateKey).toString('base64url')}
  return {runId:'run-1',issueId:'issue-1',deviceId:'dev-1',repoId:'repo-1',baseBranch:'main',harness:'codex' as const,prompt:'p',leaseExpiresAt:new Date(now+600_000).toISOString(),policy,policyRevision:context.revision,policySnapshotRequired:true,policySnapshot:snapshot}
}
const json=(body:unknown,status=200)=>Response.json(body,{status})
afterEach(()=>{vi.useRealTimers();cleanupTempDirs()})

describe('signed policy distribution',()=>{
  it('verifies final policy/hash against an independently fetched context at the existing issuer',async()=>{
    const run=fixture(),calls:string[]=[]
    const link=new HttpServerLink(issuer,async(url,init)=>{calls.push(String(url));expect(new Headers(init?.headers).get('x-mikka-policy-snapshot')).toBe('1');return json(context)})
    await link.verifyRunPolicy(run,new AbortController().signal)
    expect(calls).toEqual([`${issuer}/v1/runs/run-1/policy-snapshot?deviceId=dev-1`])
    expect(run.policy.readOnly).toBe(true)
    expect(run.policy.permissions.computer_use).toBe('deny')
    expect(Object.isFrozen(run.policy)).toBe(true)
    expect(run.policySnapshot.payload.policyHash).toBe(policySnapshotHash(run.policy))
  })
  it('rejects policy tampering, owner/device/run substitution, untrusted issuer and expiry',()=>{
    const run=fixture(),expected={runId:run.runId,deviceId:run.deviceId,revision:run.policyRevision,policy:run.policy}
    for(const change of [
      (p:PolicySnapshotPayload)=>{p.policy.readOnly=false},
      (p:PolicySnapshotPayload)=>{p.ownerId='foreign'},
      (p:PolicySnapshotPayload)=>{p.deviceId='foreign'},
      (p:PolicySnapshotPayload)=>{p.runId='foreign'},
      (p:PolicySnapshotPayload)=>{p.issuer='https://foreign.invalid'},
    ]) {const bad=structuredClone(run.policySnapshot);change(bad.payload);expect(()=>verifyPolicySnapshot(bad,context,expected)).toThrow()}
    expect(()=>verifyPolicySnapshot(run.policySnapshot,context,expected,{now:run.policySnapshot.payload.expiresAt})).toThrow('policySnapshotExpired')
  })
  it('renews an expired snapshot online while retaining the final Factory/computer restrictions',async()=>{
    vi.useFakeTimers();const now=Date.now(),run=fixture(now-POLICY_SNAPSHOT_TTL_MS-1000);let renews=0
    const link=new HttpServerLink(issuer,async(_url,init)=>{
      if(init?.method==='POST') {renews++;const body=JSON.parse(String(init.body));expect(body.snapshot.payload.policyHash).toBe(policySnapshotHash(run.policy));return json(fixture(now).policySnapshot)}
      return json(context)
    })
    await link.verifyRunPolicy(run,new AbortController().signal)
    expect(renews).toBe(1);expect(run.policySnapshot.payload.expiresAt).toBe(now+POLICY_SNAPSHOT_TTL_MS)
    expect(run.policy.readOnly).toBe(true);expect(run.policy.permissions.computer_use).toBe('deny')
  })
  it('refuses first offline use, missing required envelopes and a context at another issuer',async()=>{
    const run=fixture()
    await expect(new HttpServerLink(issuer,async()=>{throw Error('offline')}).verifyRunPolicy(run,new AbortController().signal)).rejects.toThrow()
    await expect(new HttpServerLink(issuer,async()=>json({...context,issuer:'https://other.invalid'})).verifyRunPolicy(run,new AbortController().signal)).rejects.toThrow()
    await expect(new HttpServerLink(issuer,async()=>json(context)).verifyRunPolicy({...run,policySnapshot:undefined},new AbortController().signal)).rejects.toThrow('Signed run policy required')
  })
  it('keeps online liveness mandatory and revokes when renewal cannot reach the issuer',async()=>{
    vi.useFakeTimers();const run=fixture();let offline=false,checks=0
    const link=new HttpServerLink(issuer,async(url)=>{
      if(offline)throw Error('offline')
      if(String(url).includes('policy-snapshot'))return json(context)
      checks++;return json({live:true})
    })
    const gate=await link.prepareRunToolApproval(run,new AbortController().signal,()=>{})
    try {
      expect(await gate.checkLive()).toBe(true);expect(checks).toBe(1)
      offline=true;vi.setSystemTime(run.policySnapshot.payload.expiresAt)
      expect(await gate.checkLive()).toBe(false);await vi.advanceTimersByTimeAsync(1000);expect(gate.revoked).toBe(true)
      expect(checks).toBe(1)
    } finally {gate.revoke()}
  })
})

it.each([false,true])('rejects an invalid snapshot before repository, setup or adapter effects (resume=%s)',async resumed=>{
  const root=tempDir(),run=fixture(),journal=new RunJournal(join(root,'runs.json'))
  const prepareRepository=vi.fn(),create=vi.fn(),bootstrap=vi.fn(),start=vi.fn(),resume=vi.fn()
  const deps={journal,adapterStateDir:join(root,'adapters'),log:createLogger({level:'silent'}),
    adapters:new Map([['codex',{harness:'codex',capabilities:{supportsResume:true,supportsInterject:false},envAllow:[],start,resume}]]),
    repository:()=>({repoId:'repo-1',name:'fixture',path:root}),prepareRepository,
    worktrees:{create,bootstrap},verifyRunPolicy:async()=>{throw Error('policySnapshotSignatureInvalid')},
    outbox:{push(){},lastChunkSeq(){return 0},async compact(){}},
  } as unknown as SupervisorDeps
  const supervisor=new RunSupervisor(deps)
  if(resumed){journal.put({assignment:run,state:'running',sessionId:'prior-session',worktree:null,lastSeq:0,error:null,updatedAt:new Date().toISOString()});await supervisor.resumeAll()}
  else supervisor.start(run)
  await supervisor.idle()
  expect(journal.get(run.runId)?.error).toContain('policySnapshotSignatureInvalid')
  for(const effect of [prepareRepository,create,bootstrap,start,resume])expect(effect).not.toHaveBeenCalled()
})

it('registers the saved device session before verifying a signed active journal during real daemon startup',async()=>{
  const dataDir=tempDir(),repo=await makeRepo(),paths=daemonPaths(dataDir)
  const run={...fixture(),harness:'mock' as const,fixture:'stall',remoteUrl:pathToFileURL(repo).href}
  writeJsonAtomic(paths.device,{credential:'isolated-device-session',deviceId:run.deviceId})
  const journal=new RunJournal(paths.journal)
  journal.put({assignment:run,state:'queued',sessionId:null,worktree:null,lastSeq:0,error:null,updatedAt:new Date().toISOString()})
  const pathsSeen:string[]=[],headersSeen:(string|null)[]=[]
  const link=new HttpServerLink(issuer,async(url,init)=>{
    const path=new URL(String(url)).pathname;pathsSeen.push(path);headersSeen.push(new Headers(init?.headers).get('authorization'))
    if(path.endsWith('/register'))return json({deviceId:run.deviceId,workspaceId:'adfb4aa9-5ff8-42cf-a300-80aebbf2b1d8'})
    if(path.endsWith('/policy-snapshot'))return json(context)
    if(path.endsWith('/heartbeat'))return json({leases:{[run.runId]:new Date(Date.now()+600_000).toISOString()}})
    if(path.endsWith('/repos'))return json({repos:[]})
    if(path.endsWith('/runs'))return json({runIds:[]})
    if(path.endsWith('/tool-approval'))return json({live:true})
    if(path.endsWith('/coordinator'))return new Response(null,{status:404})
    return json({})
  })
  const daemon=new Daemon({dataDir,flavor:'dev',link,quotaSource:null,heartbeatMs:60_000,harnesses:[{harness:'mock',installed:true,version:'test'}],log:createLogger({level:'silent'})})
  try {
    await daemon.start()
    await waitFor(()=>{const state=daemon.supervisor.get(run.runId);if(state.error)throw Error(state.error);return state.state==='running'})
    expect(pathsSeen[0]).toBe('/mikka/v1/devices/register')
    const verification=pathsSeen.findIndex(path=>path.endsWith('/policy-snapshot'))
    expect(verification).toBeGreaterThan(0)
    expect(headersSeen[verification]).toBe('Bearer isolated-device-session')
    expect(daemon.supervisor.get(run.runId).error).toBeNull()
  } finally {await daemon.stop()}
})

it('binds the verified final digest to real child environment and sandbox policy before child effects',async()=>{
  const run=fixture(),repo=await makeRepo(),root=tempDir()
  await new HttpServerLink(issuer,async()=>json(context)).verifyRunPolicy(run,new AbortController().signal)
  const options={harness:'codex' as const,worktree:repo,runDir:join(root,'run'),privateDir:root,policy:run.policy,policyHash:run.policySnapshot.payload.policyHash}
  const ctx=new RunContext(options)
  expect(ctx.policy().denyWrite).toContain(repo)
  expect(ctx.policy().allowWrite).not.toContain(repo)
  const observed=execFileSync(process.execPath,['-e','process.stdout.write(process.env.MIKKA_POLICY_HASH || "missing")'],{env:ctx.tempEnv(),encoding:'utf8'})
  expect(observed).toBe(run.policySnapshot.payload.policyHash)
  const denied=join(root,'denied')
  expect(()=>new RunContext({...options,policy:{...run.policy,readOnly:false},runDir:denied})).toThrow('Run child policy hash mismatch')
  expect(existsSync(denied)).toBe(false)
})
