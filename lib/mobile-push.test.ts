import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pushAllowed, pushBody } from './mobile-push'
import { DEFAULT_PREFERENCES } from './preferences'

test('defaults push decisions but not finished threads', () => {
  assert.equal(pushAllowed(DEFAULT_PREFERENCES, ['decide']), true)
  assert.equal(pushAllowed(DEFAULT_PREFERENCES, ['finished']), false)
})

test('proactive off pushes nothing', () => {
  assert.equal(pushAllowed({ ...DEFAULT_PREFERENCES, proactive: false }, ['decide']), false)
})

test('push text drops citations and Markdown', () => {
  assert.equal(pushBody('**PR** [[run:12345678-1234-1234-1234-123456789abc]] 修好了，见 [日志](https://x.dev/a)。'), 'PR 修好了，见 日志。')
})

test('long text is cut with an ellipsis', () => {
  const body = pushBody('字'.repeat(400))
  assert.equal(body.length, 180)
  assert.ok(body.endsWith('…'))
})
