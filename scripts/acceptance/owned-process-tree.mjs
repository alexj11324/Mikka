import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

// The dedicated subreaper remains the ancestor of setsid/double-fork children.
export async function processTree(rootPid) {
  const rows = new Map()
  await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(async name => {
    try {
      const stat = await readFile('/proc/' + name + '/stat', 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
      const status = await readFile('/proc/' + name + '/status', 'utf8')
      rows.set(Number(name), { pid: Number(name), ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]), state: fields[0],
        startTicks: fields[19], uid: Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]),
        rssBytes: Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1] ?? 0) * 1024 })
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error }
  }))
  const members = new Set([rootPid])
  let added = true
  while (added) {
    added = false
    for (const row of rows.values()) if (members.has(row.ppid) && !members.has(row.pid)) { members.add(row.pid); added = true }
  }
  return [...members].map(pid => rows.get(pid)).filter(row => row && row.state !== 'Z')
}
export async function stopTree(child, leaderStart, receiptPath) {
  if (!child?.pid) return { stopped: true, forced: false }
  let rows = await processTree(child.pid)
  const leader = rows.find(row => row.pid === child.pid)
  assert.ok(!leader || !leaderStart || leader.startTicks === leaderStart, 'OWNED_SUPERVISOR_PID_REUSED')
  if (leader) {
    try { child.kill('SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const deadline = performance.now() + 35_000
  while ((rows = await processTree(child.pid)).length && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(rows.length, 0, 'OWNED_SUPERVISOR_CLOSE_TIMEOUT')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  assert.equal(receipt.supervisorPid, child.pid)
  assert.equal(receipt.subreaperConfirmed, true)
  assert.equal(receipt.status, 'passed')
  assert.equal(receipt.liveRemaining, 0)
  assert.equal(typeof receipt.forced, 'boolean')
  const expectedExit = receipt.rootExitCode === 0
    || receipt.signalReceived === 15 && [-15, 143].includes(receipt.rootExitCode)
    || receipt.signalReceived === 2 && [-2, 130].includes(receipt.rootExitCode)
  if (!receipt.forced) assert.ok(expectedExit, 'OWNED_APPLICATION_EXIT_FAILED')
  for (const row of receipt.observed) {
    let current
    try {
      const stat = await readFile('/proc/' + row.pid + '/stat', 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
      current = fields[19] === row.startTicks && fields[0] !== 'Z'
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error }
    assert.ok(!current, 'OWNED_DESCENDANT_REMAINED')
  }
  return { stopped: true, forced: receipt.forced, subreaper: true, observedDescendants: receipt.observed.length,
    detachedDescendants: receipt.observed.filter(row => row.sid !== child.pid).length, remainingDescendants: 0,
    receiptPath, rootExitCode: receipt.rootExitCode }
}
