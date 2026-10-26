import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { writeFile, symlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createAcceptanceResourceRegistry, type ProcessIdentity } from './acceptance-resource-registry'

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
