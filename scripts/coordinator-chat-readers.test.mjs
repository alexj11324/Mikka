import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

// #1414: a web screen that keeps getCoordinatorChat (200 messages and every
// citation) under the chat's key turns each push or focus into a full read.
// The web chat reads incrementally (pollCoordinatorChat); lists read summaries.
const ALLOWED = new Set(['app/actions/coordinator.ts', 'app/api/mobile/chat/route.ts'])

test('only the mobile chat route reads the whole Coordinator chat', () => {
  const files = execFileSync('git', ['grep', '-l', '-w', 'getCoordinatorChat', '--', 'app', 'components', 'hooks', 'lib'], { encoding: 'utf8' })
    .split('\n').filter(file => file && !/\.test\.[cm]?[jt]sx?$/.test(file))
  assert.deepEqual(files.filter(file => !ALLOWED.has(file)), [])
})
