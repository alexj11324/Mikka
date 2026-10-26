import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createAcceptanceResourceRegistry } from '../../lib/credentials/acceptance-resource-registry'
import { prepareAdmission, admitRun, admitCall, admitSpawn, admitCleanup } from './credential-admission.mjs'

async function fixture() {
  const registry = await createAcceptanceResourceRegistry(tmpdir(), { profiles: 2, launches: 2 })
  const reservations = [await registry.reserveLaunch(), await registry.reserveLaunch()]
  const executable = join(registry.root, 'fixture-target')
  await writeFile(executable, '#!/bin/sh\nprintf "fixture-target-reached\\n"\n', { mode: 0o700 })
  const binding = { synthetic: 'contract-only' }
  const prepared = prepareAdmission(registry.root, binding, reservations, executable, 'contract-fixture')
  const approval = { decision: 'approve-single-synthetic-cycle', manifestHash: prepared.manifestHash, nonce: prepared.plan.nonce, source: prepared.plan.source, maxStarts: 4, maxSessionRootsRemoved: 2, maxDatabaseRowsDeleted: 0, implicitTermination: 'only-owned-wrapper-groups-including-preflight-startup-timeout-host-exit', retainRegistryEvidence: true, authorizationReference: 'UNIT FIXTURE ONLY — no browser or disposal', launchExpiresAt: new Date(Date.now() + 60000).toISOString() }
  const approve = () => writeFile(join(registry.root, 'approval.json'), JSON.stringify(approval), { mode: 0o600, flag: 'wx' })
  return { ...prepared, binding, approve, root: registry.root, approval }
}
const identity = (plan: any, pid = 2000000000) => ({ pid, pgid: pid, sid: pid, ppid: plan.host.pid, uid: plan.uid, starttime: '1' })
const args = (plan: any, index = 0) => [`--user-data-dir=${plan.sessions[index].profile}`]

test('missing approval and mismatched binding cannot consume the run', async () => {
  const f = await fixture()
  assert.throws(() => admitRun(f.plan, f.binding), /ENOENT/)
  await f.approve()
  assert.throws(() => admitRun(f.plan, { synthetic: 'foreign' }))
  admitRun(f.plan, f.binding)
  assert.throws(() => admitRun(f.plan, f.binding), /EEXIST/)
})

test('approval expiry, altered manifest and source fail closed', async () => {
  const f = await fixture()
  f.approval.launchExpiresAt = '2000-01-01T00:00:00Z'
  await f.approve()
  assert.throws(() => admitRun(f.plan, f.binding), /expired/)
  assert.throws(() => admitRun({ ...f.plan, source: 'changed' }, f.binding))
  assert.throws(() => admitRun({ ...f.plan, binding: { synthetic: 'changed' } }, { synthetic: 'changed' }), /manifest changed/)
})

test('two calls each permit two native attempts; replacement requires retained surrogate absence', async () => {
  const f = await fixture(); await f.approve(); admitRun(f.plan, f.binding)
  assert.throws(() => admitCall(f.plan, 'replacement', f.binding))
  admitCall(f.plan, 'initial', f.binding)
  assert.throws(() => admitCall(f.plan, 'initial', f.binding), /EEXIST/)
  assert.throws(() => admitCleanup(f.plan, 'initial', f.binding), /unrecorded startup/)
  for (let n = 0; n < 2; n++) assert.equal(admitSpawn(f.plan, 'initial', identity(f.plan, 2000000000 + n), args(f.plan), true), n + 1)
  assert.throws(() => admitSpawn(f.plan, 'initial', identity(f.plan), args(f.plan), true), /retry budget/)
  assert.equal(admitCleanup(f.plan, 'initial', f.binding).authorized, true)
  assert.ok((await stat(f.plan.sessions[0].directory)).isDirectory())
  // Non-destructive surrogate only: retain every byte, never claim physical cleanup acceptance.
  await rename(f.plan.sessions[0].directory, f.plan.sessions[0].directory + '.retained')
  admitCall(f.plan, 'replacement', f.binding)
  for (let n = 0; n < 2; n++) assert.equal(admitSpawn(f.plan, 'replacement', identity(f.plan, 2000000002 + n), args(f.plan, 1), true), n + 1)
  assert.throws(() => admitSpawn(f.plan, 'replacement', identity(f.plan), args(f.plan, 1), true), /retry budget/)
})

test('foreign process group, owner or profile cannot register an attempt', async () => {
  const f = await fixture(); await f.approve(); admitRun(f.plan, f.binding); admitCall(f.plan, 'initial', f.binding)
  for (const patch of [{ pgid: 42 }, { uid: f.plan.uid + 1 }, { ppid: 42 }]) assert.throws(() => admitSpawn(f.plan, 'initial', { ...identity(f.plan), ...patch }, args(f.plan), true))
  assert.throws(() => admitSpawn(f.plan, 'initial', identity(f.plan), args(f.plan, 1), true))
  assert.equal(admitSpawn(f.plan, 'initial', identity(f.plan), args(f.plan), true), 1)
})

test('official executable wrapper records before harmless exec and refuses third attempt without signals', async () => {
  const f = await fixture(); await f.approve(); admitRun(f.plan, f.binding)
  const config = admitCall(f.plan, 'initial', f.binding)
  const run = () => new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(config.executablePath, args(f.plan), { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; child.stdout.on('data', data => { stdout += data }); child.stderr.resume()
    child.on('error', reject); child.on('close', code => resolve({ code, stdout }))
  })
  for (let n = 1; n <= 2; n++) {
    const result = await run(); assert.equal(result.code, 0); assert.match(result.stdout, /fixture-target-reached/)
    const receipt = JSON.parse(await readFile(join(f.root, `initial-spawn-${n}.json`), 'utf8'))
    assert.equal(receipt.attempt, n); assert.equal(receipt.process.pid, receipt.process.pgid)
  }
  const rejected = await run(); assert.equal(rejected.code, 78); assert.equal(rejected.stdout, '')
})

test('owner evidence mutation and cross-reservation directory replacement block admission', async () => {
  const f = await fixture(); await f.approve()
  const ownerPath = join(f.root, 'owner.json'), owner = await readFile(ownerPath, 'utf8')
  await writeFile(ownerPath, owner + '\n')
  assert.throws(() => admitRun(f.plan, f.binding))
  await writeFile(ownerPath, owner)
  await rename(f.plan.sessions[0].profile, f.plan.sessions[0].profile + '.retained')
  assert.throws(() => admitRun(f.plan, f.binding), /ENOENT/)
})

test('concurrent run admission consumes one receipt and approval changes block further calls', async () => {
  const f = await fixture(); await f.approve()
  const results = await Promise.allSettled([0, 1].map(() => Promise.resolve().then(() => admitRun(f.plan, f.binding))))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected').length, 1)
  await writeFile(join(f.root, 'approval.json'), JSON.stringify({ ...f.approval, authorizationReference: 'different fixture receipt' }))
  assert.throws(() => admitCall(f.plan, 'initial', f.binding))
})

test('composed lifecycle admits receipt-bound cleanup after browser exit without requiring a live child', async () => {
  const { bindAcceptanceLifecycle } = await import('../../lib/credentials/acceptance-lifecycle')
  const f = await fixture(); await f.approve()
  let registered = false
  const profiles = f.plan.sessions.map((s: any) => ({ id: s.id, directory: s.directory, profile: s.profile, artifacts: s.artifacts }))
  const resources = bindAcceptanceLifecycle({
    async prepareProfile() { throw Error('already prepared') },
    async started() { registered = true },
    async beforeCleanup() { if (registered) throw Error('old registry requires a live PID') },
  }, profiles, f.plan, f.binding as any)
  const profile = await resources.prepareProfile(f.binding as any)
  await resources.admitLaunch!(profile, f.binding as any)
  admitSpawn(f.plan, 'initial', identity(f.plan), args(f.plan), true)
  await resources.started(profile)
  const result = await resources.beforeCleanup(profile, 'setup-failed')
  assert.deepEqual(result, { authorized: true, directory: profile.directory })
  // Calling admission twice models inner close then outer failure, without closing anything.
  assert.deepEqual(await resources.beforeCleanup(profile, 'launch-failed'), result)
  assert.ok((await stat(profile.directory)).isDirectory())
})

test('runtime source digest binds helper files as well as the main bundle', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { runtimeSourceDigest } = await import('./credential-admission.mjs')
  const root = await mkdtemp(join(tmpdir(), 'runtime-digest-fixture-'))
  await writeFile(join(root, 'coreBundle.js'), 'synthetic main')
  await writeFile(join(root, 'utilsBundle.js'), 'synthetic helper')
  const before = runtimeSourceDigest(root)
  await writeFile(join(root, 'utilsBundle.js'), 'changed synthetic helper')
  assert.notEqual(runtimeSourceDigest(root), before)
  await writeFile(join(root, 'additional.js'), 'new dependency')
  assert.notEqual(runtimeSourceDigest(root), before)
})

test('reservation entry rejects registry root, traversal, reused inode and symlink alias before wrappers', async () => {
  const { symlink } = await import('node:fs/promises')
  for (const variant of ['dot', 'traversal', 'root-inode', 'role-alias', 'symlink']) {
    const registry = await createAcceptanceResourceRegistry(tmpdir(), { profiles: 2, launches: 2 })
    const reservations: any[] = [await registry.reserveLaunch(), await registry.reserveLaunch()]
    const rootStat = await stat(registry.root)
    if (variant === 'dot') { reservations[0].id = '.'; reservations[0].directory = registry.root }
    if (variant === 'traversal') reservations[0].id = '../foreign'
    if (variant === 'root-inode') reservations[0].directories[0] = { ...reservations[0].directories[0], dev: String(rootStat.dev), ino: String(rootStat.ino) }
    if (variant === 'role-alias') reservations[1] = reservations[0]
    if (variant === 'symlink') {
      const p = reservations[0].profile
      await rename(p, p + '.retained'); await symlink(p + '.retained', p)
    }
    assert.throws(() => prepareAdmission(registry.root, {}, reservations, join(registry.root, 'fixture-target'), 'contract-fixture'))
    await assert.rejects(stat(join(registry.root, 'initial-exec.sh')), /ENOENT/)
    assert.ok((await stat(registry.root)).isDirectory())
  }
})

test('an unfrozen actual runner is rejected even with a resource-contract approval', async () => {
  const f = await fixture(); await f.approve()
  assert.throws(() => admitRun({ ...f.plan, kind: 'executor-positive-once' }, f.binding), /runner not frozen/)
  await assert.rejects(stat(join(f.root, 'run-consumed.json')), /ENOENT/)
})

test('path replacement during close is refused before the removal callback', async () => {
  const { mkdir } = await import('node:fs/promises')
  const { disposeAcceptanceSession } = await import('../../lib/credentials/owned-chromium')
  const f = await fixture(); await f.approve(); admitRun(f.plan, f.binding); admitCall(f.plan, 'initial', f.binding)
  admitSpawn(f.plan, 'initial', identity(f.plan), args(f.plan), true)
  const s = f.plan.sessions[0]
  let removals = 0, checks = 0
  await assert.rejects(disposeAcceptanceSession({
    async prepareProfile() { return s }, async started() {},
    async beforeCleanup() { checks++; return admitCleanup(f.plan, 'initial', f.binding) },
  }, s, async () => {
    await rename(s.directory, s.directory + '.retained')
    await mkdir(s.directory, { mode: 0o700 })
  }, async () => { removals++ }))
  assert.equal(checks, 2); assert.equal(removals, 0)
  assert.ok((await stat(s.directory)).isDirectory())
  assert.ok((await stat(s.directory + '.retained')).isDirectory())
})

test('fixed positive cycle calls open/execute/end once and asserts restored state without browser or removal', async () => {
  const { positiveCycle } = await import('./credential-positive-once')
  const calls: string[] = []; let ended = false
  const binding = { ownerId: 'synthetic', workspaceId: 'w', taskId: 't', runId: 'r', executionSession: 'e', authSessionId: 'a' }
  await positiveCycle({
    async open(actual) { assert.deepEqual(actual, binding); calls.push('open') },
    async readDOM(actual) { assert.notEqual(actual.ownerId, binding.ownerId); throw Object.assign(Error('wrong binding'), { code: 'browser_session_not_found' }) },
    async execute(actual, service, capability) {
      assert.deepEqual(actual, binding); assert.equal(service, 'fixture')
      assert.equal(await capability.resolveAndAdmit(), 'synthetic-only'); assert.equal(await capability.stillAuthorized(), true)
      calls.push('execute'); return { phase: 'restored', result: 'site_policy_verified', cleanup: 'isolated_context_destroyed' }
    },
    state() { if (ended) throw Object.assign(Error('closed'), { code: 'browser_session_not_found' }); return { phase: 'restored', fenced: false } },
    async end() { calls.push('end'); ended = true },
  }, binding, { serviceId: 'fixture', syntheticPassword: 'synthetic-only' })
  assert.deepEqual(calls, ['open', 'execute', 'end'])
})

test('fixed scenario and actual entry identity must both match before admission', async () => {
  const { fileURLToPath } = await import('node:url')
  const { assertScenario, fixedRunnerCommand } = await import('./credential-admission.mjs')
  const runner = fileURLToPath(new URL('./credential-positive-once.ts', import.meta.url))
  const scenario = JSON.parse(await readFile(new URL('./credential-positive-scenario.json', import.meta.url), 'utf8'))
  const plan = { kind: 'executor-positive-once', runner, scenario }
  assert.doesNotThrow(() => assertScenario(plan, fixedRunnerCommand()))
  assert.throws(() => assertScenario(plan, [process.execPath, '/foreign/runner.ts', runner]))
  assert.throws(() => assertScenario(plan, [...fixedRunnerCommand(), '--require', '/foreign.js']))
  assert.throws(() => assertScenario(plan, fixedRunnerCommand(), {}, '/foreign/check-out'))
  assert.throws(() => assertScenario(plan, fixedRunnerCommand(), { NODE_OPTIONS: '--import=/foreign.js' }))
  assert.throws(() => assertScenario(plan, fixedRunnerCommand(), { ESBUILD_BINARY_PATH: '/foreign' }))
  assert.throws(() => assertScenario({ ...plan, scenario: { ...scenario, maxApiCalls: 3 } }, [runner]))
  assert.throws(() => assertScenario({ ...plan, scenario: { ...scenario, origin: 'https://example.test' } }, [runner]))
})
