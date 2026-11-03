import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { nativeRunIdentity, ownedDaemonGroups, processTable, suspendOwnedDaemon } from './daemon-fault.mjs'

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
  const dataDir = await mkdtemp(join(tmpdir(), 'mikka-native-fault-'))
  const runId = '11111111-1111-4111-8111-111111111111'
  let nativePid, fault, nativeFault
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
    const owner = { pid: a.pid, parentPid: process.pid, daemonPid: a.pid, forbiddenPids: [process.pid, b.pid] }
    await mkdir(join(dataDir, 'adapters/pids'), { recursive: true })
    const pidFile = join(dataDir, 'adapters/pids', `${runId}.pgid`)
    await writeFile(pidFile, String(b.pid))
    await assert.rejects(() => nativeRunIdentity(owner, { dataDir, runId, worktree: process.cwd() }), /isolated descendant/)
    await writeFile(pidFile, String(nativePid))
    await assert.rejects(() => nativeRunIdentity(owner, { dataDir, runId, worktree: dataDir }), /cwd/)
    const native = await nativeRunIdentity(owner, { dataDir, runId, worktree: process.cwd() })
    await assert.rejects(() => suspendOwnedDaemon({ ...native, start: 'reused-pid' }), /reused/)
    nativeFault = await suspendOwnedDaemon(native)
    const nativePaused = await processTable()
    assert.equal(nativePaused.find(row => row.pid === nativePid).state, 'T')
    assert.notEqual(nativePaused.find(row => row.pid === a.pid).state, 'T', 'The daemon must keep its heartbeat/lease loop')
    assert.notEqual(nativePaused.find(row => row.pid === b.pid).state, 'T')
    await nativeFault.resume()
  } finally {
    await nativeFault?.resume()
    await fault?.resume()
    for (const pid of [a.pid, b.pid, nativePid]) if (pid) {
      try { process.kill(-pid, 'SIGCONT'); process.kill(-pid, 'SIGTERM') } catch { /* Already ended. */ }
    }
    await rm(dataDir, { recursive: true, force: true })
  }
})
