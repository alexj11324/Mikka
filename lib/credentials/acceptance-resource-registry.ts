// Test-only inventory. Matching is evidence, NOT permission to kill/remove resources.
// No signal, unlink, rm, browser launch or disposal capability is exposed here.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type ProcessIdentity = { pid: number; starttime: string; uid: number; profile: string }
type Reservation = { id: string; profile: string; dev: string; ino: string }
type Registration = Reservation & { process: ProcessIdentity }

export async function readLinuxProcess(pid: number): Promise<ProcessIdentity> {
  assert.ok(Number.isSafeInteger(pid) && pid > 1)
  const base = `/proc/${pid}`
  const stat = await readFile(join(base, 'stat'), 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  const status = await readFile(join(base, 'status'), 'utf8')
  const uid = /^Uid:\s+(\d+)/m.exec(status)
  const args = (await readFile(join(base, 'cmdline'), 'utf8')).split('\0')
  const profiles = args.filter(arg => arg.startsWith('--user-data-dir='))
  assert.equal(profiles.length, 1, 'exact browser profile argument required')
  assert.ok(uid && /^\d+$/.test(fields[19]), 'Linux process identity required')
  // Detect process replacement during observation; callers still must not use
  // a later numeric-PID signal on the strength of this read-only observation.
  const again = await readFile(join(base, 'stat'), 'utf8')
  assert.equal(again.slice(again.lastIndexOf(')') + 2).trim().split(/\s+/)[19], fields[19])
  return { pid, starttime: fields[19], uid: Number(uid[1]), profile: profiles[0].slice(16) }
}

export async function createAcceptanceResourceRegistry(parent: string, budget: { profiles: number; launches: number }, inspect = readLinuxProcess) {
  for (const n of [budget.profiles, budget.launches]) assert.ok(Number.isSafeInteger(n) && n > 0)
  const limits = { ...budget }
  const root = await realpath(await mkdtemp(join(parent, 'credential-resources-')))
  const runId = randomUUID(), uid = process.getuid!()
  const owner = JSON.stringify({ runId, uid, root, budget: limits })
  const marker = join(root, 'owner.json')
  await writeFile(marker, owner, { flag: 'wx', mode: 0o600 })
  const rootStat = await lstat(root, { bigint: true })
  const reservations = new Map<string, Reservation>()
  const registrations = new Map<string, Registration>()
  const attempted = new Set<string>()
  let launches = 0, profiles = 0
  async function owned() {
    const st = await lstat(root, { bigint: true })
    assert.ok(st.isDirectory() && !st.isSymbolicLink())
    assert.equal(st.dev, rootStat.dev); assert.equal(st.ino, rootStat.ino)
    assert.equal(Number(st.uid), uid); assert.equal(Number(st.mode & BigInt(0o077)), 0)
    const markerStat = await lstat(marker)
    assert.ok(markerStat.isFile() && !markerStat.isSymbolicLink())
    assert.equal(markerStat.uid, uid); assert.equal(markerStat.mode & 0o077, 0)
    assert.equal(await readFile(marker, 'utf8'), owner)
  }
  async function profileMatches(r: Reservation) {
    await owned()
    assert.equal(await realpath(r.profile), r.profile)
    const st = await lstat(r.profile, { bigint: true })
    assert.ok(st.isDirectory() && !st.isSymbolicLink())
    assert.equal(Number(st.uid), uid)
    assert.equal(st.dev.toString(), r.dev); assert.equal(st.ino.toString(), r.ino)
  }
  return {
    root, runId,
    // Counts attempts before creating anything; failed attempts never refund a budget.
    async reserveLaunch() {
      assert.ok(profiles < limits.profiles && launches < limits.launches, 'resource budget exhausted')
      profiles++; launches++
      await owned()
      const id = randomUUID(), profile = join(root, id)
      await mkdir(profile, { mode: 0o700 })
      const st = await lstat(profile, { bigint: true })
      const r = { id, profile, dev: st.dev.toString(), ino: st.ino.toString() }
      reservations.set(id, r)
      await writeFile(join(root, `${id}.reservation.json`), JSON.stringify(r), { flag: 'wx', mode: 0o600 })
      return { ...r, env: { TMPDIR: root } }
    },
    async registerStarted(id: string, pid: number) {
      assert.ok(Number.isSafeInteger(pid) && pid > 1)
      const r = reservations.get(id)
      assert.ok(r && !attempted.has(id), 'unregistered one-use launch reservation required')
      attempted.add(id)
      await profileMatches(r)
      const identity = await inspect(pid)
      assert.equal(identity.pid, pid); assert.equal(identity.uid, uid)
      assert.equal(identity.profile, r.profile)
      assert.match(identity.starttime, /^\d+$/)
      const registration = { ...r, process: { ...identity } }
      await writeFile(join(root, `${id}.process.json`), JSON.stringify(registration), { flag: 'wx', mode: 0o600 })
      // Only durable registrations may match; attempted already fences duplicates.
      registrations.set(id, registration)
    },
    async matchesRegistered(id: string) {
      const r = registrations.get(id)
      assert.ok(r, 'this run has no registered resource')
      await profileMatches(r)
      assert.deepEqual(await inspect(r.process.pid), r.process, 'process identity changed')
      return { runId, id, profile: r.profile, pid: r.process.pid, starttime: r.process.starttime }
    },
  }
}
