// Test-only inventory. Matching is evidence, NOT permission to kill/remove resources.
// No signal, unlink, rm, browser launch or disposal capability is exposed here.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AcceptanceResources, AcceptanceProfile } from './owned-chromium'

export type ProcessIdentity = { pid: number; starttime: string; uid: number; profile: string }
type Reservation = { id: string; profile: string; dev: string; ino: string }
type Registration = Reservation & { process: ProcessIdentity }
class NoBrowserProfile extends Error {}

// Preserve bounded cause identity and controlled diagnosis, never raw Playwright
// messages/stacks (which may contain command arguments, URLs or credentials).
export function safeLaunchFailure(cause: unknown) {
  const chain: { code: string; messageHash: string }[] = [], seen = new Set<object>()
  let current = cause
  for (let depth = 0; depth < 4 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current)
    const value = Object.getOwnPropertyDescriptor(current, 'message')?.value
    const message = typeof value === 'string' ? value : ''
    const code = /error while loading shared libraries/i.test(message) ? 'shared-library-missing'
      : /executable doesn.t exist|spawn .*ENOENT|executable.*not found/i.test(message) ? 'executable-missing'
      : /no usable sandbox|running as root without --no-sandbox/i.test(message) ? 'sandbox-unavailable'
      : /EACCES|EPERM|permission denied/i.test(message) ? 'permission-denied'
      : /timeout|timed out/i.test(message) ? 'launch-timeout'
      : /target.*closed|process did exit|browser.*closed/i.test(message) ? 'process-or-target-closed'
      : 'unclassified-launch-failure'
    chain.push({ code, messageHash: createHash('sha256').update(message).digest('hex') })
    current = Object.getOwnPropertyDescriptor(current, 'cause')?.value
  }
  return { version: 1, chain, rawMessageRetained: false, causeChainBound: 4 }
}

// Receipt errors must never turn a retained browser host into an implicit exit.
// No overwrite or disposal is permitted, including when diagnosis itself fails.
export async function writeRetainedReceipt(path: string, payload: unknown,
  report: (message: string) => void | Promise<void> = console.error,
  writer: (path: string, content: string) => Promise<void> = (target, content) => writeFile(target, content, { flag: 'wx', mode: 0o600 }),
): Promise<boolean> {
  try {
    await writer(path, JSON.stringify(payload))
    return true
  } catch {
    try { await report('retained receipt write failed; process retained') } catch { /* logging is also non-fatal */ }
    return false
  }
}

export function parseProcStat(text: string) {
  const end = text.lastIndexOf(')')
  assert.ok(end > 0, 'invalid proc stat')
  const fields = text.slice(end + 2).trim().split(/\s+/)
  assert.match(fields[1] ?? '', /^\d+$/)
  assert.match(fields[19] ?? '', /^\d+$/)
  return { ppid: Number(fields[1]), starttime: fields[19] }
}

// Some Linux procfs mounts omit task/*/children. Scan stat PPIDs instead;
// missing processes may have exited, but permission/malformed reads must fail.
export async function procChildren(parentPid: number, io = {
  entries: () => readdir('/proc'),
  stat: (pid: number) => readFile(`/proc/${pid}/stat`, 'utf8'),
}): Promise<number[]> {
  assert.ok(Number.isSafeInteger(parentPid) && parentPid > 1)

  const parent = parseProcStat(await io.stat(parentPid))
  const entries = await io.entries()
  assert.ok(entries.length <= 65536, 'unexpected proc inventory')
  const children = new Set<number>()
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
    try {
      const first = parseProcStat(await io.stat(pid))
      if (first.ppid !== parentPid) continue
      const second = parseProcStat(await io.stat(pid))
      assert.deepEqual(second, first, 'child identity changed during inventory')
      children.add(pid)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  assert.deepEqual(parseProcStat(await io.stat(parentPid)), parent, 'parent identity changed during inventory')
  assert.ok(children.size <= 1024, 'unexpected child process inventory')
  return [...children]
}

export async function processSnapshot(pid: number, io = {
  stat: (id: number) => readFile(`/proc/${id}/stat`, 'utf8'),
  status: (id: number) => readFile(`/proc/${id}/status`, 'utf8'),
  cmdline: (id: number) => readFile(`/proc/${id}/cmdline`, 'utf8'),
}) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1)
  const before = parseProcStat(await io.stat(pid))
  const status = await io.status(pid), uid = /^Uid:\s+(\d+)/m.exec(status)
  assert.ok(uid, 'process UID required')
  const args = (await io.cmdline(pid)).split('\0')
  assert.deepEqual(parseProcStat(await io.stat(pid)), before, 'process changed during snapshot')
  return { pid, ...before, uid: Number(uid[1]), args }
}

export async function ownNodeChildren(): Promise<number[]> {
  return procChildren(process.pid)
}

export async function uniqueChildForProfile(profile: string, children = ownNodeChildren, inspect = readLinuxProcess) {
  const matching: ProcessIdentity[] = []
  for (const pid of new Set(await children())) {
    assert.ok(Number.isSafeInteger(pid) && pid > 1)
    let identity: ProcessIdentity
    try { identity = await inspect(pid) }
    catch (error) { if (error instanceof NoBrowserProfile || (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    assert.equal(identity.pid, pid)
    if (identity.profile === profile) matching.push(identity)
  }
  assert.equal(matching.length, 1, 'exactly one own Node child must match the reserved profile')
  assert.equal(matching[0].uid, process.getuid!(), 'foreign browser process owner')
  return matching[0]
}

export async function readLinuxProcess(pid: number): Promise<ProcessIdentity> {
  assert.ok(Number.isSafeInteger(pid) && pid > 1)
  const base = `/proc/${pid}`
  const stat = await readFile(join(base, 'stat'), 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  const status = await readFile(join(base, 'status'), 'utf8')
  const uid = /^Uid:\s+(\d+)/m.exec(status)
  const args = (await readFile(join(base, 'cmdline'), 'utf8')).split('\0')
  const profiles = args.filter(arg => arg.startsWith('--user-data-dir='))
  if (!profiles.length) throw new NoBrowserProfile()
  assert.equal(profiles.length, 1, 'exact browser profile argument required')
  assert.ok(uid && /^\d+$/.test(fields[19]), 'Linux process identity required')
  // Detect process replacement during observation; callers still must not use
  // a later numeric-PID signal on the strength of this read-only observation.
  const again = await readFile(join(base, 'stat'), 'utf8')
  assert.equal(again.slice(again.lastIndexOf(')') + 2).trim().split(/\s+/)[19], fields[19])
  return { pid, starttime: fields[19], uid: Number(uid[1]), profile: profiles[0].slice(16) }
}

export async function createAcceptanceResourceRegistry(parent: string, budget: { profiles: number; launches: number }, inspect = readLinuxProcess, children = ownNodeChildren) {
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
    assert.equal(Number(st.mode & BigInt(0o077)), 0, 'private browser profile required')
    assert.equal(st.dev.toString(), r.dev); assert.equal(st.ino.toString(), r.ino)
  }
  const registry = {
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
    acceptanceResources(): AcceptanceResources {
      const check = async (profile: AcceptanceProfile) => {
        const r = reservations.get(profile.id)
        assert.ok(r, 'unknown acceptance reservation')
        assert.equal(profile.directory, root); assert.equal(profile.profile, r.profile)
        await profileMatches(r)
        return r
      }
      return {
        async prepareProfile() {
          const r = await registry.reserveLaunch()
          return Object.freeze({ id: r.id, directory: root, profile: r.profile })
        },
        async started(profile) {
          const r = await check(profile)
          const candidate = await uniqueChildForProfile(r.profile, children, inspect)
          await registry.registerStarted(r.id, candidate.pid)
          // Recheck both parent membership and identity after durable registration.
          const current = await uniqueChildForProfile(r.profile, children, inspect)
          assert.deepEqual(current, candidate, 'browser changed during registration')
          await registry.matchesRegistered(r.id)
        },
        async beforeCleanup(profile, stage) {
          await check(profile)
          const registered = registrations.has(profile.id)
          if (registered) {
            const current = await uniqueChildForProfile(profile.profile, children, inspect)
            const known = await registry.matchesRegistered(profile.id)
            assert.equal(current.pid, known.pid); assert.equal(current.starttime, known.starttime)
          }
          // A failed/unconfirmed launch has no verified PID. Retain it and its
          // evidence, never infer absence or authorize cleanup by name/prefix.
          await writeFile(join(root, `${randomUUID()}.pending.json`), JSON.stringify({ runId, id: profile.id, stage, registered, disposition: 'pending-retained' }), { flag: 'wx', mode: 0o600 })
        },
        async recordFailure(profile, stage, cause) {
          await check(profile)
          await writeFile(join(root, `${randomUUID()}.failure.json`), JSON.stringify({ runId, id: profile.id, stage, diagnostic: safeLaunchFailure(cause) }), { flag: 'wx', mode: 0o600 })
        },
      }
    },
  }
  return registry
}
