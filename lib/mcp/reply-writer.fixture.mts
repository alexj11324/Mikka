import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'

assert.ok(disposableDatabase(process.env, process.env.E2E_DATABASE_URL), 'isolated loopback fixture only')
const owner = process.env.MCP_TEST_OWNER, botId = process.env.MCP_TEST_BOT
assert.ok(owner && botId)
const gateway = new URL(process.env.DEVICE_GATEWAY_URL ?? '')
assert.equal(gateway.hostname, '127.0.0.1')
const original = await import('../live/notify')
const pending: Promise<void>[] = []
mock.module('../live/notify', { namedExports: {
  ...original,
  scheduleLive: (work: () => Promise<void>) => { pending.push(work()) },
} })
const { appendMessages } = await import('../../tests/support/legacy-coordinator-store')
const { pool } = await import('../db')
const { workspacePool } = await import('../workspace-db')
try {
  await appendMessages(owner, 'mcp-fixture-holder', [{ role: 'assistant', content: 'Reply from a separate writer process' }], null, botId)
  await Promise.all(pending)
  process.stdout.write(JSON.stringify({ written: true, notifications: pending.length }) + '\n')
} finally {
  await Promise.all([pool.end(), workspacePool.end()])
}
