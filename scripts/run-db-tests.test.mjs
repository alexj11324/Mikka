import assert from 'node:assert/strict'
import test from 'node:test'
import { checkSummary, main, parseSummary } from './run-db-tests.mjs'

test('parses TAP and spec summaries', () => {
  assert.deepEqual(parseSummary('# tests 4\n# pass 4\n# fail 0\n# skipped 0\n'), { tests: 4, pass: 4, fail: 0, skipped: 0 })
  assert.deepEqual(parseSummary('ℹ tests 2\nℹ pass 1\nℹ skipped 1\n'), { tests: 2, pass: 1, skipped: 1 })
})
test('rejects skips, empty runs, missing summary and failures', () => {
  assert.equal(checkSummary('s', 0, { tests: 3, pass: 3, skipped: 0, fail: 0 }), null)
  assert.match(checkSummary('s', 0, { tests: 3, pass: 2, skipped: 1 }), /1 skipped/)
  assert.match(checkSummary('s', 0, { tests: 0 }), /ran no tests/)
  assert.match(checkSummary('s', 0, {}), /no node:test summary/)
  assert.match(checkSummary('s', 1, { tests: 1 }), /exited with 1/)
  assert.match(checkSummary('s', 0, { tests: 2, pass: 2, todo: 1 }), /1 todo/)
})

test('an allowlisted script missing from package.json fails before anything runs', () => {
  assert.equal(main(['test:does-not-exist'], { 'test:other': 'node -e 0' }), 1)
  assert.equal(main([], {}), 0, 'an empty allowlist passes')
})
