// Local acceptance only: suspend a verified, isolated daemon tree without
// terminating the watched service or stopping Next/the independent cron.
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

export async function processTable() {
  const rows = await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(async name => {
    try {
      const value = await readFile(`/proc/${name}/stat`, 'utf8')
      const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/)
      return { pid: Number(name), state: fields[0], ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] }
    } catch { return null } // A process may exit while the snapshot is read.
  }))
  return rows.filter(Boolean)
}

export function ownedDaemonGroups(rows, { pid, parentPid, daemonPid, forbiddenPids = [] }) {
  const root = rows.find(row => row.pid === pid)
  assert.ok(root && pid > 1 && root.ppid === parentPid && root.pgid === pid, 'A must be the isolated child recorded by this owned local stack')
  const owned = new Set([pid])
  for (let changed = true; changed;) {
    changed = false
    for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true }
  }
  assert.ok(owned.has(daemonPid), 'Authenticated daemon.status PID is outside the owned A process tree')
  for (const value of forbiddenPids) assert.ok(!owned.has(value), 'Refusing to suspend the runner, B, or the local server')
  const groups = new Set(rows.filter(row => owned.has(row.pid)).map(row => row.pgid))
  for (const row of rows) if (groups.has(row.pgid)) assert.ok(owned.has(row.pid), 'A process group contains an unrelated process')
  return { root, groups: [pid, ...[...groups].filter(group => group !== pid)], members: rows.filter(row => owned.has(row.pid)) }
}

export async function suspendOwnedDaemon(identity) {
  assert.equal(process.platform, 'linux', 'Handoff fault injection requires Linux process ownership evidence')
  const original = ownedDaemonGroups(await processTable(), identity)
  if (identity.start !== undefined) assert.equal(original.root.start, identity.start, 'Owned process PID was reused before suspension')
  const paused = new Map()
  let resumePromise
  const resume = () => resumePromise ??= (async () => {
    // Resume the daemon before separately detached native children, allowing its
    // normal heartbeat/lease fencing to run. No server state is edited here.
    for (const [pgid, members] of paused) {
      const current = (await processTable()).filter(row => row.pgid === pgid)
      if (!current.length) continue
      assert.ok(current.every(row => members.some(saved => saved.pid === row.pid && saved.start === row.start)), 'Refusing to signal a reused process group')
      try { process.kill(-pgid, 'SIGCONT') } catch (error) { if (error.code !== 'ESRCH') throw error }
      if (pgid === identity.pid && paused.size > 1) await delay(1_000)
    }
  })()
  try {
    for (let round = 0; round < 8; round++) {
      const snapshot = ownedDaemonGroups(await processTable(), identity)
      assert.equal(snapshot.root.start, original.root.start, 'Owned daemon PID was reused')
      for (const pgid of snapshot.groups) {
        const members = snapshot.members.filter(row => row.pgid === pgid)
        paused.set(pgid, members)
        process.kill(-pgid, 'SIGSTOP')
      }
      await delay(20)
      const stopped = ownedDaemonGroups(await processTable(), identity)
      if (stopped.members.every(row => ['T', 't', 'Z', 'X'].includes(row.state))) {
        for (const pgid of stopped.groups) paused.set(pgid, stopped.members.filter(row => row.pgid === pgid))
        return { resume, groups: paused.size, processes: stopped.members.length, suspendedAt: new Date().toISOString() }
      }
    }
    throw new Error('A process tree did not reach a fully suspended state')
  } catch (error) { await resume(); throw error }
}

/** ClaudeAdapter.spawnBinary starts one CLI as a direct child, in the run's
 * cwd, without a separate process group. Never read a credential journal or
 * infer that the legacy spawnCli PID-file path applies to this SDK transport. */
export async function nativeRunIdentity(daemonIdentity, { worktree, sessionId }) {
  assert.ok(typeof sessionId === 'string' && sessionId.length, 'The actual run must already have a native session')
  const rows = await processTable()
  const owned = ownedDaemonGroups(rows, daemonIdentity)
  const target = await stat(worktree)
  const matches = (await Promise.all(owned.members.filter(row => row.ppid === daemonIdentity.daemonPid).map(async row => {
    try { const cwd = await stat(`/proc/${row.pid}/cwd`); return cwd.dev === target.dev && cwd.ino === target.ino ? row : null }
    catch { return null }
  }))).filter(Boolean)
  if (matches.length !== 1) throw Object.assign(new Error('The run must have exactly one live native child in its worktree'), { code: 'nativeCandidateNotUnique' })
  const leader = matches[0]
  return { pid: leader.pid, parentPid: leader.ppid, start: leader.start, processGroupId: leader.pgid, daemonProcessGroupId: owned.root.pgid,
    forbiddenPids: [...(daemonIdentity.forbiddenPids ?? []), daemonIdentity.pid, daemonIdentity.daemonPid] }
}

function descendantRows(rows, rootPid) {
  const ids = new Set([rootPid])
  for (let changed = true; changed;) {
    changed = false
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true }
  }
  return rows.filter(row => ids.has(row.pid))
}

/** Suspend individual verified PIDs: a Claude CLI may share the daemon PGID.
 * Retain identities across reparenting and restore all remaining owned PIDs,
 * even when an earlier child exited or a PID was reused. No negative PID signal. */
export async function suspendNativeRun(identity) {
  const initial = await processTable(), root = initial.find(row => row.pid === identity.pid)
  assert.ok(root && root.ppid === identity.parentPid && root.start === identity.start, 'Native process identity changed before suspension')
  const tracked = new Map()
  const remember = rows => {
    for (const row of rows) {
      assert.ok(!identity.forbiddenPids.includes(row.pid), 'Refusing to suspend the daemon, server, runner or B')
      if (tracked.has(row.pid)) assert.equal(tracked.get(row.pid).start, row.start, 'Native PID was reused')
      tracked.set(row.pid, row)
    }
  }
  remember(descendantRows(initial, identity.pid))
  const currentOwned = async () => {
    const current = await processTable(), result = [], reused = []
    for (const saved of tracked.values()) {
      const row = current.find(value => value.pid === saved.pid)
      if (!row) continue
      if (row.start !== saved.start) { reused.push(row.pid); continue }
      result.push(row)
    }
    return { result, reused }
  }
  let restorePromise
  const resume = () => restorePromise ??= (async () => {
    const { result, reused } = await currentOwned(), errors = []
    for (const row of result.sort((a, b) => Number(b.pid === identity.pid) - Number(a.pid === identity.pid))) {
      try { process.kill(row.pid, 'SIGCONT') } catch (error) { if (error.code !== 'ESRCH') errors.push(error) }
      if (row.pid === identity.pid) await delay(100)
    }
    if (reused.length || errors.length) throw new AggregateError(errors, 'Some native PIDs changed identity; all other owned processes were resumed')
  })()
  const terminate = async () => {
    const { result, reused } = await currentOwned(), errors = []
    for (const row of result.reverse()) {
      try { process.kill(row.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') errors.push(error) }
    }
    if (reused.length || errors.length) throw new AggregateError(errors, 'Some native PIDs changed identity; all other owned processes were terminated')
  }
  try {
    // Freeze the root first, then catch descendants that were already forking.
    process.kill(identity.pid, 'SIGSTOP')
    for (let round = 0; round < 8; round++) {
      remember(descendantRows(await processTable(), identity.pid))
      const { result, reused } = await currentOwned()
      assert.equal(reused.length, 0)
      for (const row of result) process.kill(row.pid, 'SIGSTOP')
      await delay(20)
      remember(descendantRows(await processTable(), identity.pid))
      const stopped = await currentOwned()
      if (stopped.result.some(row => row.pid === identity.pid) && stopped.result.every(row => ['T', 't', 'Z', 'X'].includes(row.state))) {
        return { resume, terminate, processes: stopped.result.length, suspendedAt: new Date().toISOString(),
          async assertSuspended() {
            const check = await currentOwned()
            assert.equal(check.reused.length, 0, 'A captured native PID was reused')
            assert.ok(check.result.some(row => row.pid === identity.pid), 'Native root exited before the observed server stop')
            assert.ok(check.result.every(row => ['T', 't', 'Z', 'X'].includes(row.state)), 'Native execution resumed before local cancellation')
          } }
      }
    }
    throw new Error('Native process tree did not reach a fully suspended state')
  } catch (error) { await terminate(); throw error }
}

/** A pending TERM/INT proves the normal daemon cancellation reached this exact
 * suspended CLI. A server DB stop flag alone is not proof its local gate closed. */
export async function nativeTerminationState(identity) {
  const row = (await processTable()).find(value => value.pid === identity.pid)
  if (!row || ['Z', 'X'].includes(row.state)) return 'exited'
  assert.equal(row.start, identity.start, 'Native PID was reused while awaiting cancellation')
  const status = await readFile(`/proc/${identity.pid}/status`, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (status === null) return 'exited'
  const pending = [...status.matchAll(/^(?:SigPnd|ShdPnd):\s+([a-f0-9]+)$/gmi)].reduce((mask, match) => mask | BigInt(`0x${match[1]}`), 0n)
  return pending & (1n << 14n) ? 'SIGTERM' : pending & (1n << 1n) ? 'SIGINT' : null
}
