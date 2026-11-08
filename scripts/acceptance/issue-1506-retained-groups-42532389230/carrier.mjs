// Materialized original four-group retained cleanup. The workflow remains literal-false.
// No acceptance predicates are reimplemented; every business call uses an original CLI mode.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve, sep, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const driver = resolve('driver-source'), output = resolve('group-cleanup-report')
const prefix = 'scripts/acceptance/issue-1506-alex/'
const plan = JSON.parse(readFileSync(join(here, 'plan.json'), 'utf8'))
const actions = ['final-groups', 'final-workspace', 'verify-deletion', 'retained-groups']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(plan.schemaVersion, 1)
assert.ok(actions.includes(plan.action), 'Select a concrete cleanup action; disabled is not runnable')
assert.equal(plan.driverSha, process.env.DRIVER_SHA)
assert.equal(plan.applicationSha, process.env.APP_SHA)
mkdirSync(output, { recursive: true })

function load(descriptor, base = here) {
  assert.ok(descriptor && typeof descriptor.path === 'string' && /^[0-9a-f]{64}$/.test(descriptor.sha256))
  const path = resolve(base, descriptor.path)
  assert.ok(path.startsWith(base + sep), 'Receipt must stay under its declared input root')
  const bytes = readFileSync(path)
  assert.equal(hash(bytes), descriptor.sha256)
  return { path, value: JSON.parse(bytes.toString('utf8')), bytes: bytes.length, sha256: descriptor.sha256 }
}

const mode = process.argv[2]
assert.ok(['carrier-preflight', 'carrier-run'].includes(mode))
if (mode === 'carrier-preflight') {
  // Same offline import barrier as the old carrier. This is never a model test.
  let networkAttempts = 0
  globalThis.fetch = () => { networkAttempts++; throw Error('offline_network_forbidden') }
  globalThis.WebSocket = class { constructor() { networkAttempts++; throw Error('offline_network_forbidden') } }
  const fixtureModule = await import(pathToFileURL(join(driver, prefix, 'coordinator-fixtures.mjs')))
  const groupModule = await import(pathToFileURL(join(driver, prefix, 'group-stop.mjs')))
  const fixture = load(plan.fixture, driver)
  const fixtures = fixtureModule.validateFixtureReceipt(fixture.value, { ready: true })
  if (plan.action === 'retained-groups') {
    assert.ok(Array.isArray(plan.retainedGroups) && plan.retainedGroups.length > 0, 'No real retained receipts selected')
    for (const descriptor of plan.retainedGroups) {
      const group = groupModule.validateGroupReceipt(load(descriptor).value, fixtures)
      assert.equal(group.applicationSha, plan.applicationSha)
      // Deliberately do not require a successful observe status / Stop ACK.
      // Failed observations may still own a real group needing cleanup.
    }
  } else {
    const finalModule = await import(pathToFileURL(join(driver, prefix, 'final-cleanup.mjs')))
    const evidence = finalModule.loadCleanupEvidence(load(plan.canonicalManifest).path)
    assert.equal(evidence.manifest.applicationSha, plan.applicationSha)
    if (plan.groupProgress) finalModule.validateGroupCleanupProgress(load(plan.groupProgress).value, evidence,
      { complete: plan.action === 'final-workspace' })
    if (plan.action === 'final-workspace') assert.ok(plan.groupProgress, 'Original workspace CLI requires group progress')
    if (plan.action === 'verify-deletion') load(plan.workspaceProgress)
  }
  assert.equal(networkAttempts, 0)
  writeFileSync(join(output, 'preflight.json'), JSON.stringify({ schemaVersion: 1, issue: 1506,
    action: plan.action, originalValidators: true, networkAttempts, businessCalls: 0,
    acceptanceVerdict: 'not_produced' }, null, 2) + '\n')
} else {
  const rows = []
  function execute(label, script, args, timeout) {
    const options = { cwd: driver, encoding: 'utf8', maxBuffer: 1024 * 1024,
      env: { ...process.env, MIKKA_FIXTURE_RECEIPT: plan.fixture.path } }
    if (timeout) options.timeout = timeout
    const child = spawnSync(process.execPath, [prefix + script, ...args], options)
    writeFileSync(join(output, label + '.stdout'), child.stdout ?? '')
    writeFileSync(join(output, label + '.stderr'), child.stderr ?? '')
    rows.push({ label, originalScript: script, originalMode: args[0], exitCode: child.status,
      signal: child.signal, launchError: child.error?.code ?? null, automaticRetry: false })
    writeFileSync(join(output, 'summary.json'), JSON.stringify({ schemaVersion: 1, issue: 1506,
      action: plan.action, driverSha: plan.driverSha, observationApplicationSha: plan.applicationSha,
      rows, allSelectedCommandsExitedZero: rows.every(row => row.exitCode === 0),
      acceptanceVerdict: 'not_produced', modelSendCommands: 0,
      workspaceDeletionRequested: plan.action === 'final-workspace' }, null, 2) + '\n')
    return child.status === 0
  }
  if (plan.action === 'retained-groups') {
    for (const [index, descriptor] of plan.retainedGroups.entries()) {
      const receipt = load(descriptor)
      // Reuse the existing ACME 11-second login quiet spacing, outside sample timing.
      await new Promise(resolve => setTimeout(resolve, 11_000))
      execute('retained-' + String(index + 1).padStart(2, '0'), 'group-stop.mjs', ['cleanup', receipt.path], 220_000)
    }
  } else {
    const manifestPath = load(plan.canonicalManifest).path
    if (execute('validate', 'final-cleanup.mjs', ['validate', manifestPath])) {
      const originalMode = plan.action === 'final-groups' ? 'groups' : plan.action === 'final-workspace' ? 'workspace' : 'verify-deletion'
      const descriptor = originalMode === 'verify-deletion' ? plan.workspaceProgress : plan.groupProgress
      const args = [originalMode, manifestPath]
      if (descriptor) args.push(load(descriptor).path)
      execute(originalMode, 'final-cleanup.mjs', args)
    }
  }
  if (rows.some(row => row.exitCode !== 0)) process.exitCode = 1
}
