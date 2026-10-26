import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { retainedGoPattern, retainedGoTap, retainedCleanupSnapshots } from './byos-go-evidence.mjs'
import { parseEvidence } from '../scripts/db-test-plan.mjs'

test('retained Go evidence requires exact completed tests and refuses pending, skipped or failed output', () => {
  const contract = JSON.parse(readFileSync(new URL('../packages/subscription-worker/retained-test-contract.json', import.meta.url)))
  const Package = 'github.com/alexj11324/Mikka/subscription-worker'
  const rows = contract.retainedTests.flatMap(Test => [
    { Package, Action: 'run', Test }, { Package, Action: 'pass', Test },
  ]).concat({ Package, Action: 'pass' })
  const json = events => events.map(event => JSON.stringify(event)).join('\n')
  const raw = json(rows)
  const result = parseEvidence(retainedGoTap(raw, contract))
  assert.equal(result.counts.tests, contract.retainedCount)
  assert.equal(result.counts.pass, contract.retainedCount)
  assert.deepEqual([...result.names].sort(), [...contract.retainedTests].sort())
  const pattern = new RegExp(retainedGoPattern(contract))
  for (const name of contract.retainedTests) assert.ok(pattern.test(name))
  for (const { name } of contract.pendingTests) assert.ok(!pattern.test(name))
  for (const invalid of [
    rows.slice(1), rows.slice(0, -1), [...rows, rows[0]],
    [...rows, { Package, Action: 'skip', Test: contract.retainedTests[0] + '/nested' }],
    [...rows, { Package, Action: 'fail' }],
    [...rows, { Package, Action: 'run', Test: contract.pendingTests[0].name }],
    [...rows, { Package: 'other', Action: 'pass' }],
  ]) assert.throws(() => retainedGoTap(json(invalid), contract))
  assert.throws(() => retainedGoTap(raw + '\nnot-json', contract))
  assert.throws(() => retainedGoPattern({ ...contract, retainedCount: contract.retainedCount + 1 }))
})


test('cleanup snapshots reassemble split Go output and retain exact two blocked receipts', () => {
  const snapshot = { Status: 'blocked', EffectsComplete: false, Artifacts: [{ Name: 'a'.repeat(1800) }], Attempts: [{ StateHash: 'b'.repeat(64) }], EnrollmentRows: [] }
  const make = value => '    fixture.go:1: retained cleanup exact inventory: ' + JSON.stringify(value) + '\n'
  const log = make(snapshot) + make({ ...snapshot, EnrollmentRows: null })
  const events = []
  for (let i = 0; i < log.length; i += 1024) events.push({ Test: 'TestCleanupPauseRetainsArtifactsAndAttempts', Action: 'output', Output: log.slice(i, i + 1024) })
  const raw = events.map(x => JSON.stringify(x)).join('\n')
  assert.deepEqual(retainedCleanupSnapshots(raw), [snapshot, { ...snapshot, EnrollmentRows: null }])
  assert.throws(() => retainedCleanupSnapshots(events.slice(0, -1).map(x => JSON.stringify(x)).join('\n')))
  assert.throws(() => retainedCleanupSnapshots(raw + '\n' + raw))
  assert.throws(() => retainedCleanupSnapshots(JSON.stringify({ Test: 'TestCleanupPauseRetainsArtifactsAndAttempts', Action: 'output', Output: make({ ...snapshot, EffectsComplete: true }) })))
})
