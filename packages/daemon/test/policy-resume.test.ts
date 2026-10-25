import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RunAssignment, DeviceRepo } from '@mikka/protocol'
import { RunSupervisor } from '../src/runs/supervisor'
import { RunJournal } from '../src/runs/journal'
import { WorktreeManager } from '../src/worktrees'
import { Outbox } from '../src/outbox'
import { createLogger } from '../src/log'
import { MemoryServer } from '../src/server-link'
import { cleanupTempDirs, tempDir } from './helpers'
afterEach(cleanupTempDirs)
function fixture(revalidate?: (a:RunAssignment)=>Promise<string>, leased = true, remote?: boolean) {
  const dir=tempDir('policy-resume-'), log=createLogger()
  const journal=new RunJournal(join(dir,'runs.json'))
  const assignment:RunAssignment={runId:'policy-run',issueId:'policy-issue',deviceId:'policy-device',repoId:'policy-repo',baseBranch:'main',harness:'mock',prompt:'synthetic',...(leased?{leaseExpiresAt:new Date(Date.now()+60000).toISOString()}:{})}
  journal.put({assignment,state:'running',sessionId:'policy-session',worktree:join(dir,'worktree'),lastSeq:0,error:null,updatedAt:new Date().toISOString()})
  const repo:DeviceRepo={repoId:'policy-repo',name:'synthetic',path:dir}
  const supervisor=new RunSupervisor({journal,outbox:new Outbox(join(dir,'outbox'),new MemoryServer().link(),log),worktrees:new WorktreeManager(join(dir,'worktrees')),adapters:new Map(),repos:()=>[repo],log,revalidateRunLease:revalidate,requireOnlineResumes:remote})
  const launch=vi.spyOn(supervisor as unknown as {launch(id:string,repo:DeviceRepo):void},'launch').mockImplementation(()=>{})
  return {supervisor,journal,launch}
}
it('unexpired journal leases cannot launch offline or manufacture grace on repeated restarts',async()=>{
  const check=vi.fn(async()=>{throw new Error('offline')})
  const f=fixture(check)
  await f.supervisor.resumeAll();await f.supervisor.resumeAll()
  expect(check).toHaveBeenCalledTimes(2);expect(f.launch).not.toHaveBeenCalled()
  expect(f.supervisor.get('policy-run').leaseExpiresAt).toBeUndefined()
  expect(f.journal.get('policy-run')?.error).toContain('current online policy')
})
it('blocked run launches only after a fresh future server lease, then clears the denial',async()=>{
  let online=false
  const expiry=new Date(Date.now()+60000).toISOString()
  const f=fixture(async()=>{if(!online)throw new Error('revoked');return expiry})
  await f.supervisor.resumeAll();expect(f.launch).not.toHaveBeenCalled()
  online=true;await f.supervisor.resumeAll(true)
  expect(f.launch).toHaveBeenCalledTimes(1)
  expect(f.supervisor.get('policy-run').leaseExpiresAt).toBe(expiry)
  expect(f.journal.get('policy-run')?.error).toBeNull()
})
it('missing validation capability and stale or malformed responses stay blocked',async()=>{
  for(const validation of [undefined,async()=>new Date(Date.now()-1).toISOString(),async()=>'unknown-version']){
    const f=fixture(validation);await f.supervisor.resumeAll();expect(f.launch).not.toHaveBeenCalled()
  }
})
it('cancellation while current authority is checked prevents restart',async()=>{
  let resolve!:(value:string)=>void
  const f=fixture(()=>new Promise<string>(r=>{resolve=r}))
  const pending=f.supervisor.resumeAll()
  f.journal.update('policy-run',{state:'cancelled'})
  resolve(new Date(Date.now()+60000).toISOString());await pending
  expect(f.launch).not.toHaveBeenCalled()
})
it('unleased local development runs keep their explicit local behavior',async()=>{
  const f=fixture(undefined,false);await f.supervisor.resumeAll();expect(f.launch).toHaveBeenCalledTimes(1)
})

it('older remote assignments without a lease cannot use the local development exemption',async()=>{
  const f=fixture(undefined,false,true);await f.supervisor.resumeAll();expect(f.launch).not.toHaveBeenCalled()
})

it('explicit local memory development mode can resume its non-persistent fixture runs',async()=>{
  const f=fixture(undefined,true,false);await f.supervisor.resumeAll();expect(f.launch).toHaveBeenCalledTimes(1)
})
