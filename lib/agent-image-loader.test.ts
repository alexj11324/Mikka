import assert from 'node:assert/strict'
import test from 'node:test'
import { agentImageKey } from './agent-image-loader'

test('图片卡片请求 /api/agent/images，而不是没有 GET 的 /api/agent', () => {
  const key = agentImageKey('香港 夜景')
  assert.match(key, /\/api\/agent\/images\?q=/)
  assert.ok(key.endsWith(`/api/agent/images?q=${encodeURIComponent('香港 夜景')}`))
})
