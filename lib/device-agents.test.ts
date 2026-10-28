import assert from 'node:assert/strict'
import test from 'node:test'
import type { HarnessInfo } from '@mikka/protocol/harness'
import { ensureDeviceAgents, localExecutionHarnesses } from './device-agents'

type Pool = Parameters<typeof ensureDeviceAgents>[0]

const codex: HarnessInfo = { harness: 'codex', installed: true, version: 'test' }
const claude: HarnessInfo = { harness: 'claude_code', installed: true, version: 'test' }

test('only installed production harnesses become local execution identities', () => {
  const all: HarnessInfo[] = [codex, claude, codex, { harness: 'mock', installed: true, version: 'test' }, { harness: 'cursor', installed: true, version: 'test' }]
  assert.deepEqual(localExecutionHarnesses(all, {}), ['claude_code', 'codex'])
  assert.deepEqual(localExecutionHarnesses(all, { NODE_ENV: 'test', MIKKA_TEST_MODE: '1' }), ['claude_code', 'codex', 'mock'])
  assert.deepEqual(localExecutionHarnesses([{ ...codex, installed: false }]), [])
})

test('unchanged heartbeats and cloud devices never open transactions or locks', async () => {
  for (const rows of [[{ kind: 'local', harness: 'codex' }], [{ kind: 'cloud', harness: null }]]) {
    let connects = 0
    const pool = { query: async () => ({ rows }), connect: async () => { connects++; throw new Error('unnecessary transaction') } } as unknown as Pool
    await ensureDeviceAgents(pool, 'owner', 'device', [codex])
    assert.equal(connects, 0)
  }
})

test('a mismatch locks the device, re-reads the latest report, and preserves history on removal', async () => {
  const calls: { sql: string; values?: unknown[] }[] = []
  let released = false
  const client = { release: () => { released = true }, query: async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    return { rows: sql.startsWith('SELECT harnesses') ? [{ harnesses: [claude] }] : [] }
  } }
  const pool = { query: async () => ({ rows: [{ kind: 'local', harness: null }] }), connect: async () => client } as unknown as Pool
  await ensureDeviceAgents(pool, 'owner', 'device', [codex])
  assert.match(calls[1]!.sql, /pg_advisory_xact_lock\(hashtextextended\('device-agents:' \|\| \$1,0\)\)/)
  const insert = calls.find(call => call.sql.startsWith('INSERT INTO agents'))!
  assert.equal(insert.values?.[2], 'claude_code')
  assert.equal(insert.values?.[3], 'claude_code device')
  assert.ok(calls.some(call => /UPDATE agents SET "deviceId"=NULL/.test(call.sql)))
  assert.equal(calls.some(call => /DELETE FROM agents/.test(call.sql)), false)
  assert.equal(calls.at(-1)!.sql, 'COMMIT')
  assert.equal(released, true)
})
