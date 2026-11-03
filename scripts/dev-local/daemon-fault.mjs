// Local acceptance only: suspend a verified, isolated daemon tree without
// terminating the watched service or stopping Next/the independent cron.
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
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

/** spawnCli records this numeric PGID under adapters/pids, outside the agent's
 * sandbox. Read only that run's process metadata, never its credential journal. */
export async function nativeRunIdentity(daemonIdentity, { dataDir, runId, worktree }) {
  assert.match(runId, /^[a-f0-9-]{36}$/)
  const value = (await readFile(join(dataDir, 'adapters', 'pids', `${runId}.pgid`), 'utf8')).trim()
  assert.match(value, /^[1-9][0-9]*$/, 'The owned native run needs its recorded process group')
  const rows = await processTable()
  const owned = ownedDaemonGroups(rows, daemonIdentity)
  const pid = Number(value), leader = owned.members.find(row => row.pid === pid)
  assert.ok(leader && leader.pgid === pid && pid !== daemonIdentity.pid && pid !== daemonIdentity.daemonPid, 'Native PGID must be an isolated descendant of this daemon')
  const [cwd, target] = await Promise.all([stat(`/proc/${pid}/cwd`), stat(worktree)])
  assert.equal(cwd.dev, target.dev, 'Native process cwd is outside the current run worktree')
  assert.equal(cwd.ino, target.ino, 'Native process cwd is outside the current run worktree')
  const result = { pid, parentPid: leader.ppid, daemonPid: pid, start: leader.start,
    forbiddenPids: [...(daemonIdentity.forbiddenPids ?? []), daemonIdentity.pid, daemonIdentity.daemonPid] }
  ownedDaemonGroups(rows, result)
  return result
}
