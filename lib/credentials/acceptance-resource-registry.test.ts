import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { writeFile, symlink, rename, readFile, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createAcceptanceResourceRegistry, uniqueChildForProfile, safeLaunchFailure, ownNodeChildren, procChildren, processSnapshot, type ProcessIdentity } from './acceptance-resource-registry'
import { OwnedChromiumExecutor, rejectAcceptanceDisposal, guardAcceptanceLaunch, type AcceptanceResources } from './owned-chromium'

test('registry reserves explicit budgets before creation and retains a private per-run root', async () => {
  const registry = await createAcceptanceResourceRegistry(tmpdir(), { profiles: 1, launches: 1 })
  const r = await registry.reserveLaunch()
  assert.equal(r.env.TMPDIR, registry.root)
  await assert.rejects(registry.reserveLaunch(), /budget exhausted/)
  await assert.rejects(registry.matchesRegistered(r.id), /no registered resource/)
})

test('registered resource rejects PID reuse, foreign profile and unknown run record', async () => {
  let observed: ProcessIdentity
  const registry = await createAcceptanceResourceRegistry(tmpdir(), { profiles: 2, launches: 2 }, async () => ({ ...observed }))
  const r = await registry.reserveLaunch()
  observed = { pid: 12345, starttime: '100', uid: process.getuid!(), profile: r.profile }
  await registry.registerStarted(r.id, observed.pid)
  assert.equal((await registry.matchesRegistered(r.id)).starttime, '100')
  observed.starttime = '101'
  await assert.rejects(registry.matchesRegistered(r.id), /identity changed/)
  observed.starttime = '100'; observed.profile = join(registry.root, 'foreign')
  await assert.rejects(registry.matchesRegistered(r.id), /identity changed/)
  await assert.rejects(registry.matchesRegistered('foreign'), /no registered resource/)
  const second = await registry.reserveLaunch()
  await assert.rejects(registry.registerStarted(second.id, observed.pid))
  observed.profile = second.profile
  await assert.rejects(registry.registerStarted(second.id, observed.pid), /one-use/)
})

test('profile symlink substitution and owner-marker changes fail closed without deleting fixtures', async () => {
  let observed: ProcessIdentity
  const registry = await createAcceptanceResourceRegistry(tmpdir(), { profiles: 1, launches: 1 }, async () => ({ ...observed }))
  const r = await registry.reserveLaunch()
  observed = { pid: 12345, starttime: '100', uid: process.getuid!(), profile: r.profile }
  await registry.registerStarted(r.id, observed.pid)
  await rename(r.profile, r.profile + '.retained')
  await symlink(r.profile + '.retained', r.profile)
  await assert.rejects(registry.matchesRegistered(r.id))
  await writeFile(join(registry.root, 'owner.json'), 'changed owner')
  await assert.rejects(registry.matchesRegistered(r.id))
})

test('concurrent registration consumes one reservation exactly once', async () => {
  let observed: ProcessIdentity
  const registry = await createAcceptanceResourceRegistry(tmpdir(), { profiles: 1, launches: 1 }, async () => ({ ...observed }))
  const r = await registry.reserveLaunch()
  observed = { pid: 12345, starttime: '100', uid: process.getuid!(), profile: r.profile }
  const results = await Promise.allSettled([registry.registerStarted(r.id, 12345), registry.registerStarted(r.id, 12345)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected').length, 1)
})

test('acceptance hook prepares before launch, registers only own matching child and always refuses disposal', async () => {
  let observed: ProcessIdentity
  const inspected: number[] = []
  const registry = await createAcceptanceResourceRegistry(tmpdir(), { profiles: 1, launches: 1 }, async pid => { inspected.push(pid); return { ...observed, pid } }, async () => [12345])
  const hook = registry.acceptanceResources(), profile = await hook.prepareProfile()
  observed = { pid: 12345, starttime: '100', uid: process.getuid!(), profile: profile.profile }
  await hook.started(profile)
  assert.ok(inspected.length > 0 && inspected.every(pid => pid === 12345))
  for (const stage of ['destroy', 'setup-failed', 'launch-failed'] as const) {
    let disposed = false
    await assert.rejects((async () => { await rejectAcceptanceDisposal(hook, profile, stage); disposed = true })(), { code: 'browser_acceptance_disposal_pending' })
    assert.equal(disposed, false)
  }
  await assert.rejects(hook.prepareProfile(), /budget exhausted/)
  await assert.rejects(hook.beforeCleanup({ ...profile, id: 'foreign' }, 'destroy'), /unknown acceptance/)
  observed.starttime = '101'
  await assert.rejects(hook.beforeCleanup(profile, 'destroy'), /identity changed/)
})

test('child discovery refuses absent, ambiguous and foreign-owner profile identities', async () => {
  const profile = '/synthetic-only/profile'
  const read = async (pid: number) => ({ pid, starttime: '100', uid: process.getuid!(), profile })
  await assert.rejects(uniqueChildForProfile(profile, async () => [], read), /exactly one/)
  await assert.rejects(uniqueChildForProfile(profile, async () => [12345, 12346], read), /exactly one/)
  await assert.rejects(uniqueChildForProfile(profile, async () => [12345], async pid => ({ ...await read(pid), uid: process.getuid!() + 1 })), /foreign browser/)
  const visited: number[] = []
  await assert.rejects(uniqueChildForProfile(profile, async () => [12345], async pid => { visited.push(pid); return { ...await read(pid), profile: '/another-owner/profile' } }), /exactly one/)
  assert.deepEqual(visited, [12345])
})

test('failed unconfirmed launch retains its profile and cannot authorize removal', async () => {
  const registry = await createAcceptanceResourceRegistry(tmpdir(), { profiles: 1, launches: 1 }, async () => { throw Error('must not inspect an unknown PID') }, async () => [])
  const hook = registry.acceptanceResources(), profile = await hook.prepareProfile()
  await assert.rejects(rejectAcceptanceDisposal(hook, profile, 'launch-failed'), { code: 'browser_acceptance_disposal_pending' })
  await assert.rejects(registry.matchesRegistered(profile.id), /no registered resource/)
  await assert.rejects(hook.started(profile), /exactly one/)
})

test('resource hook is loopback-only and preparation failure stops executor before browser launch', async () => {
  let prepared = 0, started = 0
  const hook: AcceptanceResources = { async prepareProfile() { prepared++; throw Error('fixture budget denied before launch') }, async started() { started++ }, async beforeCleanup() { throw Error('no created resource') } }
  assert.throws(() => new OwnedChromiumExecutor({ executablePath: '/never-start', policies: [], acceptanceResources: hook }), { code: 'browser_acceptance_resources_forbidden' })
  const executor = new OwnedChromiumExecutor({ executablePath: '/never-start', policies: [], loopbackFixture: true, acceptanceResources: hook })
  const binding = { ownerId: 'fixture', authSessionId: 'fixture', workspaceId: 'fixture', taskId: 'fixture', runId: 'fixture', executionSession: 'fixture' }
  await assert.rejects(executor.open(binding), /budget denied before launch/)
  assert.equal(prepared, 1); assert.equal(started, 0)
})

test('executor acceptance is setup-only even with valid reservation; no browser or PID inspection occurs', async () => {
  let inspections = 0
  const registry = await createAcceptanceResourceRegistry(tmpdir(), { profiles: 1, launches: 1 }, async () => { inspections++; throw Error('must not inspect') }, async () => { inspections++; return [] })
  const hook = registry.acceptanceResources()
  const executor = new OwnedChromiumExecutor({ executablePath: '/usr/bin/chromium', policies: [], loopbackFixture: true, acceptanceResources: hook })
  const binding = { ownerId: 'fixture', authSessionId: 'fixture', workspaceId: 'fixture', taskId: 'fixture', runId: 'fixture', executionSession: 'fixture' }
  const childrenBefore = (await ownNodeChildren()).sort((a, b) => a - b)
  await assert.rejects(executor.open(binding), { code: 'browser_acceptance_setup_only' })
  assert.deepEqual((await ownNodeChildren()).sort((a, b) => a - b), childrenBefore)
  const files = await readdir(registry.root)
  const receipts = files.filter(file => file.endsWith('.pending.json'))
  assert.equal(receipts.length, 1)
  const pending = JSON.parse(await readFile(join(registry.root, receipts[0]), 'utf8'))
  assert.equal(pending.stage, 'launch-blocked'); assert.equal(pending.registered, false)
  assert.equal((await lstat(join(registry.root, receipts[0]))).mode & 0o777, 0o600)
  const reservations = files.filter(file => file.endsWith('.reservation.json'))
  assert.equal(reservations.length, 1)
  const reservation = JSON.parse(await readFile(join(registry.root, reservations[0]), 'utf8'))
  assert.equal(reservation.id, pending.id)
  assert.equal(reservation.profile, join(registry.root, pending.id))
  const profileBefore = await lstat(reservation.profile, { bigint: true })
  assert.ok(profileBefore.isDirectory() && !profileBefore.isSymbolicLink())
  assert.equal(Number(profileBefore.mode & BigInt(0o777)), 0o700)
  assert.equal(inspections, 0); assert.equal(files.filter(file => file.endsWith('.process.json')).length, 0)
  await assert.rejects(executor.open(binding), /budget exhausted/)
  assert.deepEqual((await ownNodeChildren()).sort((a, b) => a - b), childrenBefore)
  const profileAfter = await lstat(reservation.profile, { bigint: true })
  assert.equal(profileAfter.ino, profileBefore.ino); assert.equal(profileAfter.dev, profileBefore.dev)
  assert.deepEqual((await readdir(registry.root)).sort(), files.sort())
  await assert.rejects(guardAcceptanceLaunch(hook), { code: 'browser_acceptance_profile_missing' })
  await guardAcceptanceLaunch() // Ordinary product path has no new launch restriction.
})

test('acceptance diagnostics privately preserve controlled cause codes without error text or secrets', async () => {
  const secret = 'synthetic-diagnostic-secret-not-for-output'
  const cause = new Error('error while loading shared libraries: fixture.so ' + secret)
  const error = new Error('Target browser closed https://fixture.invalid/?token=' + secret, { cause })
  const diagnostic = safeLaunchFailure(error)
  assert.deepEqual(diagnostic.chain.map(entry => entry.code), ['process-or-target-closed', 'shared-library-missing'])
  assert.ok(diagnostic.chain.every(entry => /^[a-f0-9]{64}$/.test(entry.messageHash)))
  assert.ok(!JSON.stringify(diagnostic).includes(secret))
  const registry = await createAcceptanceResourceRegistry(tmpdir(), { profiles: 1, launches: 1 })
  const hook = registry.acceptanceResources(), profile = await hook.prepareProfile()
  await hook.recordFailure!(profile, 'launch-failed', error)
  const file = (await readdir(registry.root)).find(file => file.endsWith('.failure.json'))!
  assert.ok(file)
  const path = join(registry.root, file), content = await readFile(path, 'utf8')
  assert.equal((await lstat(path)).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(content).diagnostic, diagnostic)
  assert.ok(!content.includes(secret)); assert.ok(!content.includes('fixture.invalid'))
  await assert.rejects(hook.recordFailure!({ ...profile, id: 'other-owner' }, 'launch-failed', error), /unknown acceptance/)
})


test('proc PPID inventory works without task children and rejects unreadable or replaced identities', async () => {
  const stat = (ppid: number, start = '100') => `123 (name with ) spaces) S ${ppid} ${Array(17).fill('0').join(' ')} ${start}`
  const rows = new Map([[50, stat(1)], [51, stat(50)], [52, stat(51)], [53, stat(99)]])
  const io = { entries: async () => ['self', '50', '51', '51', '52', '53', '54'], stat: async (pid: number) => {
    const row = rows.get(pid)
    if (!row) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    return row
  } }
  assert.deepEqual(await procChildren(50, io), [51])
  await assert.rejects(procChildren(50, { ...io, stat: async pid => {
    if (pid === 53) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return io.stat(pid)
  } }), /denied/)
  let reads = 0
  await assert.rejects(procChildren(50, { ...io, stat: async pid => pid === 51 ? stat(50, String(++reads)) : io.stat(pid) }), /child identity changed/)
  await assert.rejects(procChildren(50, { ...io, stat: async pid => pid === 53 ? 'invalid' : io.stat(pid) }), /invalid proc stat/)
})


test('process snapshots reject PID reuse and malformed identity before associating root references', async () => {
  const stat = (start: string) => `51 (comm ) with spaces) S 50 ${Array(17).fill('0').join(' ')} ${start}`
  const io = { stat: async () => stat('100'), status: async () => 'Uid: 1000 1000 1000 1000', cmdline: async () => 'chromium\0--user-data-dir=/synthetic/profile\0' }
  assert.deepEqual(await processSnapshot(51, io), { pid: 51, ppid: 50, starttime: '100', uid: 1000, args: ['chromium', '--user-data-dir=/synthetic/profile', ''] })
  let reads = 0
  await assert.rejects(processSnapshot(51, { ...io, stat: async () => stat(String(++reads)) }), /process changed/)
  await assert.rejects(processSnapshot(51, { ...io, stat: async () => 'bad' }), /invalid proc stat/)
  await assert.rejects(processSnapshot(51, { ...io, status: async () => '' }), /UID required/)
})
