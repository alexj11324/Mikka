import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { prepareGitHubSource, sourceAction, maintenanceSummary, preparationConfiguration, SOURCE_FIXTURE_SHA256 } from './prepare-github-source.mjs'

const fixture = JSON.parse(await readFile(new URL('./fixture-state.json', import.meta.url), 'utf8'))
const NOW = Date.parse('2026-11-07T07:00:00.000Z')
const original = { userId: fixture.ownerUserId, githubAccountId: fixture.githubSetup.githubAccountId,
  githubLogin: fixture.githubSetup.githubLogin, updatedAt: '2026-11-06T17:47:53.104Z',
  expiresAt: '2026-11-07T01:47:53.103Z', hasRefreshToken: true, refreshExpiresAt: '2027-05-06T01:47:53.103Z' }
const renewed = { ...original, updatedAt: '2026-11-07T07:00:00.000Z', expiresAt: '2026-11-07T15:00:00.000Z',
  refreshExpiresAt: '2027-05-06T07:00:00.000Z' }
const counts = { activeRuns: 0, pendingFactoryTasks: 0, pendingSubagents: 0, coordinatorLeases: 0,
  pendingPublications: 0, pendingMerges: 0, activeThreadMachines: 0, activeCloudMachines: 0 }

function harness(options = {}) {
  let owner = structuredClone(options.owner ?? original), idleCalls = 0, matchingCalls = 0
  const calls = { refresh: 0, commit: 0, rollback: 0, observations: 0, events: [] }
  const store = {
    validateFixture: async value => assert.equal(value.workspaceId, fixture.workspaceId),
    idle: async () => {
      if (++idleCalls === options.failIdleAt) throw new Error('issue1503_github_rotation_smoke_work_active')
      return counts
    },
    matching: async state => {
      assert.deepEqual(state, fixture.githubSetup)
      if (++matchingCalls === options.failMatchingAt) throw new Error('issue1503_github_renewal_connection_changed')
    },
    withLockedSource: async callback => {
      try {
        await callback({ ownerBefore: structuredClone(owner), refreshExpiredOwner: async () => {
          calls.refresh++
          calls.events.push('service')
          if (options.failService) throw new Error('SECRET_PROVIDER_RESPONSE')
          owner = structuredClone(options.renewed ?? renewed)
          calls.events.push('service_returned')
        } })
      } catch (error) { calls.rollback++; throw error }
      calls.commit++
      calls.events.push('committed')
      if (options.ambiguousCommit) throw new Error('SECRET_CONNECTION_DETAILS')
    },
    observeOwner: async () => { calls.observations++; return structuredClone(owner) },
  }
  const run = async () => prepareGitHubSource({ fixture, store, now: () => NOW,
    report: { inputFixtureSha256: SOURCE_FIXTURE_SHA256 },
    checkpoint: async report => { calls.events.push('checkpoint:' + report.stage) } })
  return { run, calls }
}

test('expired source uses one standard refresh and commits before any later checkpoint', async () => {
  const { run, calls } = harness()
  const report = await run()
  assert.equal(report.status, 'passed')
  assert.equal(report.ownerRefreshed, true)
  assert.equal(report.ownerTransactionCommitted, true)
  assert.deepEqual(report.ownerBefore, original)
  assert.deepEqual(report.ownerAfter, renewed)
  assert.equal(calls.refresh, 1)
  assert.equal(calls.rollback, 0)
  assert.deepEqual(calls.events.slice(calls.events.indexOf('service_returned'), calls.events.indexOf('committed') + 1),
    ['service_returned', 'committed'])
  assert.equal(JSON.stringify(report).includes('SECRET'), false)
})

test('a source already renewed by another normal flow is reused without calling refresh', async () => {
  const { run, calls } = harness({ owner: renewed })
  const report = await run()
  assert.equal(report.status, 'passed')
  assert.equal(report.ownerRefreshed, false)
  assert.equal(report.action, 'reuse_fresh_source')
  assert.equal(calls.refresh, 0)
  assert.deepEqual(report.ownerBefore, report.ownerAfter)
})

test('wrong identity, unavailable refresh and not-yet-expired near-expiry sources fail before refresh', async () => {
  for (const owner of [
    { ...original, userId: fixture.smokeUserId },
    { ...original, githubAccountId: '999' },
    { ...original, hasRefreshToken: false, refreshExpiresAt: null },
    { ...original, refreshExpiresAt: new Date(NOW).toISOString() },
    { ...original, expiresAt: new Date(NOW + 60_000).toISOString() },
  ]) {
    const { run, calls } = harness({ owner })
    const report = await run()
    assert.equal(report.status, 'incomplete')
    assert.equal(calls.refresh, 0)
    assert.equal(calls.commit, 0)
  }
  assert.equal(sourceAction({ ...original, expiresAt: new Date(NOW).toISOString() }, NOW), 'refresh_expired_source')
})

test('both initial and locked idle/CAS guards reject drift without calling the provider', async () => {
  for (const options of [{ failIdleAt: 1 }, { failIdleAt: 2 }, { failMatchingAt: 1 }, { failMatchingAt: 2 }]) {
    const { run, calls } = harness(options)
    const report = await run()
    assert.equal(report.status, 'incomplete')
    assert.equal(calls.refresh, 0)
    assert.equal(calls.commit, 0)
  }
})

test('post-commit readback rejection cannot roll back the refreshed credential', async () => {
  for (const next of [{ ...renewed, githubLogin: 'changed-account' },
    { ...renewed, hasRefreshToken: false, refreshExpiresAt: null }]) {
    const { run, calls } = harness({ renewed: next })
    const report = await run()
    assert.equal(report.status, 'incomplete')
    assert.equal(report.ownerRefreshed, true)
    assert.equal(report.ownerTransactionCommitted, true)
    assert.equal(calls.commit, 1)
    assert.equal(calls.rollback, 0)
    assert.equal(calls.refresh, 1)
  }
})

test('provider/ambiguous commit failures stay unknown, do one lock observation and never retry', async () => {
  for (const options of [{ failService: true }, { ambiguousCommit: true }]) {
    const { run, calls } = harness(options)
    const report = await run()
    assert.equal(report.status, 'incomplete')
    assert.equal(report.ownerRefreshed, null)
    assert.equal(report.ownerRefreshUnconfirmed, true)
    assert.equal(calls.refresh, 1)
    assert.equal(calls.observations, 1)
    assert.equal(JSON.stringify(report).includes('SECRET'), false)
  }
})

test('overall receipt records Owner renewal despite unchanged Owner during child rotation', async () => {
  const source = await harness().run()
  const { refreshExpiresAt: ignored, ...owner } = source.ownerAfter
  assert.ok(ignored)
  const rotation = { status: 'passed', phase: 'github_scoped_child_rotation', inputFixtureSha256: SOURCE_FIXTURE_SHA256,
    workspaceId: fixture.workspaceId, ownerUserId: fixture.ownerUserId, smokeUserId: fixture.smokeUserId,
    before: fixture.githubSetup, after: { ...fixture.githubSetup, tokenSha256: 'a'.repeat(64) },
    ownerBefore: owner, ownerAfter: owner, ownerUnchanged: true }
  const report = maintenanceSummary(source, rotation)
  assert.equal(report.status, 'passed')
  assert.equal(report.ownerRefreshed, true)
  assert.equal(report.rotationPhaseOwnerUnchanged, true)
  assert.equal(report.overallOwnerUnchanged, false)
  assert.equal(maintenanceSummary(source, { ...rotation, ownerBefore: { ...owner, updatedAt: original.updatedAt } }).status, 'incomplete')
  assert.equal(maintenanceSummary(source, undefined).status, 'incomplete')
  assert.throws(() => preparationConfiguration({}), /configuration_missing/)
})
