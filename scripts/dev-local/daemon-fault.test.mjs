import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { nativeRunIdentity, nativeTerminationState, ownedDaemonGroups, processTable, suspendNativeRun, suspendOwnedDaemon } from './daemon-fault.mjs'

const rows = [
  { pid: 10, ppid: 1, pgid: 10, start: '1' },
  { pid: 20, ppid: 10, pgid: 20, start: '2' },
  { pid: 21, ppid: 20, pgid: 20, start: '3' },
  { pid: 22, ppid: 21, pgid: 22, start: '4' },
  { pid: 30, ppid: 10, pgid: 30, start: '5' },
]
const identity = { pid: 20, parentPid: 10, daemonPid: 21, forbiddenPids: [10, 30] }

test('owned tree includes detached native children but never the server or B', () => {
  const result = ownedDaemonGroups(rows, identity)
  assert.deepEqual(result.groups, [20, 22])
  assert.deepEqual(result.members.map(row => row.pid), [20, 21, 22])
})

test('wrong parent, shared group, foreign daemon PID and forbidden descendants fail closed', () => {
  assert.throws(() => ownedDaemonGroups(rows, { ...identity, parentPid: 99 }), /isolated child/)
  assert.throws(() => ownedDaemonGroups(rows, { ...identity, daemonPid: 30 }), /outside/)
  assert.throws(() => ownedDaemonGroups(rows, { ...identity, forbiddenPids: [22] }), /runner, B/)
  assert.throws(() => ownedDaemonGroups([...rows, { pid: 31, ppid: 10, pgid: 22, start: '6' }], identity), /unrelated/)
  assert.throws(() => ownedDaemonGroups(rows.map(row => row.pid === 20 ? { ...row, pgid: 10 } : row), identity), /isolated child/)
})

test('real isolated process trees pause and resume without suspending the independent control process', { timeout: 15_000, skip: process.platform !== 'linux' }, async () => {
  const source = `const {spawn}=require('node:child_process');
    const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    console.log(worker.pid); setInterval(()=>{},1000);
    process.on('SIGTERM',()=>{try{process.kill(-worker.pid,'SIGTERM')}catch{};process.exit(0)});`
  const a = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const b = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
  let nativePid, fault
  try {
    nativePid = Number(String((await once(a.stdout, 'data'))[0]).trim())
    assert.ok(nativePid > 1)
    fault = await suspendOwnedDaemon({ pid: a.pid, parentPid: process.pid, daemonPid: a.pid, forbiddenPids: [process.pid, b.pid] })
    assert.equal(fault.groups, 2)
    const paused = await processTable()
    assert.equal(paused.find(row => row.pid === a.pid).state, 'T')
    assert.equal(paused.find(row => row.pid === nativePid).state, 'T')
    assert.notEqual(paused.find(row => row.pid === b.pid).state, 'T')
    await Promise.all([fault.resume(), fault.resume()])
    const resumed = await processTable()
    assert.notEqual(resumed.find(row => row.pid === a.pid).state, 'T')
    assert.notEqual(resumed.find(row => row.pid === nativePid).state, 'T')
  } finally {
    await fault?.resume()
    for (const pid of [a.pid, b.pid, nativePid]) if (pid) {
      try { process.kill(-pid, 'SIGCONT'); process.kill(-pid, 'SIGTERM') } catch { /* Already ended. */ }
    }
  }
})

test('Claude-style shared-PGID native child pauses alone and resumes only after real TERM is pending', { timeout: 15_000, skip: process.platform !== 'linux' }, async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'mikka-native-fault-'))
  const sessionId = '11111111-1111-4111-8111-111111111111'
  const nativeSource = `const {spawn}=require('node:child_process');
    const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    console.log(leaf.pid);setInterval(()=>{},1000);
    process.on('SIGTERM',()=>{try{process.kill(leaf.pid,'SIGTERM')}catch{};process.exit(0)});`
  const source = `const {spawn}=require('node:child_process');
    const worker=spawn(process.execPath,['-e',${JSON.stringify(nativeSource)},'--','--session-id',${JSON.stringify(sessionId)}],{cwd:${JSON.stringify(worktree)},stdio:['ignore','pipe','pipe']});
    worker.stdout.once('data',data=>console.log(JSON.stringify({nativePid:worker.pid,leafPid:Number(String(data).trim())})));
    setInterval(()=>{},1000);process.on('SIGTERM',()=>{try{worker.kill('SIGTERM')}catch{};process.exit(0)});`
  const a = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const b = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
  let fault, nativePid, leafPid
  try {
    ;({ nativePid, leafPid } = JSON.parse(String((await once(a.stdout, 'data'))[0])))
    const owner = { pid: a.pid, parentPid: process.pid, daemonPid: a.pid, forbiddenPids: [process.pid, b.pid] }
    await assert.rejects(() => nativeRunIdentity(owner, { worktree: tmpdir(), sessionId }), /exactly one/)
    const native = await nativeRunIdentity(owner, { worktree, sessionId })
    assert.equal(native.pid, nativePid)
    assert.equal(native.processGroupId, native.daemonProcessGroupId, 'Exercise the real Claude shared-group transport')
    await assert.rejects(() => suspendNativeRun({ ...native, start: 'reused-pid' }), /identity changed/)
    fault = await suspendNativeRun(native)
    const paused = await processTable()
    assert.equal(paused.find(row => row.pid === nativePid).state, 'T')
    assert.equal(paused.find(row => row.pid === leafPid).state, 'T')
    assert.notEqual(paused.find(row => row.pid === a.pid).state, 'T')
    assert.notEqual(paused.find(row => row.pid === b.pid).state, 'T')
    assert.equal(await nativeTerminationState(native), null, 'A DB stop flag alone cannot authorize CONT')
    // Simulate the daemon's actual child.kill(SIGTERM), not a group signal.
    process.kill(native.pid, 'SIGTERM')
    assert.equal(await nativeTerminationState(native), 'SIGTERM')
    await fault.resume()
    assert.notEqual((await processTable()).find(row => row.pid === a.pid).state, 'T')
    assert.notEqual((await processTable()).find(row => row.pid === b.pid).state, 'T')
  } finally {
    await fault?.terminate()
    for (const pid of [nativePid, leafPid]) if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* Already ended. */ } }
    for (const child of [a, b]) { try { process.kill(-child.pid, 'SIGCONT'); process.kill(-child.pid, 'SIGTERM') } catch { /* Already ended. */ } }
    await rm(worktree, { recursive: true, force: true })
  }
})
