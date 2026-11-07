import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { SOURCES, summarizeUnattributed } from './desktop-unattributed-sources-78-summary.mjs'
import { summarizeUnattributed as summarize75 } from './desktop-1bd4-unattributed-sources-summary.mjs'

const historicalBytes = fs.readFileSync(new URL('./fixtures/a907-lifecycle.json', import.meta.url))
const original = JSON.parse(historicalBytes)
const source = '052740cf37c4788853eb98df9d66ea7c646ea0c2'
const additions = ['/api/approved-writes', '/api/conversations/[id]/read', '/api/mobile/reactions']

test('the frozen 75-key historical reader stays valid while the 78-key reader refuses to reinterpret its evidence', () => {
  assert.equal(summarize75(original, source).valid, true)
  const next = summarizeUnattributed(original, source)
  assert.equal(next.valid, false)
  assert.equal(next.status, 'incomplete')
  assert.equal(next.vocabulary.keys, 78)
  assert.equal(next.comparisons.loginNativeVsWeb.sources, null)
  assert.equal(JSON.stringify(original) + '\n', JSON.stringify(JSON.parse(historicalBytes)) + '\n')
  assert.equal(next.productionAcceptance, null)
})

test('an explicitly synthetic 78-key fixture conserves 12 checkpoints and all 24 partitions with bound source hashes', () => {
  const synthetic = structuredClone(original)
  for (const window of Object.values(synthetic.queryCounts.windows)) {
    for (const row of [...window.checkpoints.map(item => item.snapshot), ...window.segments, window.total]) {
      for (const key of additions) row.unattributedSources[key] = 0
    }
  }
  const result = summarizeUnattributed(synthetic, source)
  assert.equal(result.valid, true)
  assert.equal(result.status, 'complete')
  assert.equal(result.integrity.snapshots, 12)
  assert.equal(result.integrity.refinementRowsPresent, 24)
  assert.equal(result.vocabulary.keys, SOURCES.length)
  assert.equal(result.vocabulary.sourceFileSha256, '2c6df289f057c4bb63acd4bc2eac33233c785ab57e152e3484bcffbf0065dc5c')
  assert.equal(result.counterImplementation.sha256, '475df35d2998e1eab7f9dd186261c2ef00d50b2a31a5ec4feb65a786217d5396')
  assert.equal(result.productionAcceptance, null)
  assert.equal(result.subtractPkceOrBackground, false)
  // This in-memory fixture checks parser compatibility only; it is never saved as measured evidence.
})

test('a new key with a private value cannot enter the closed projection', () => {
  const synthetic = structuredClone(original)
  for (const window of Object.values(synthetic.queryCounts.windows)) {
    for (const row of [...window.checkpoints.map(item => item.snapshot), ...window.segments, window.total]) {
      for (const key of additions) row.unattributedSources[key] = 0
    }
  }
  synthetic.queryCounts.windows.nativeLogin.checkpoints[0].snapshot.unattributedSources['/api/approved-writes'] = 'PRIVATE_SOURCE_VALUE_CANARY'
  const result = summarizeUnattributed(synthetic, source)
  assert.equal(result.valid, false)
  assert.equal(JSON.stringify(result).includes('PRIVATE_SOURCE_VALUE_CANARY'), false)
  assert.equal(result.productionAcceptance, null)
})
