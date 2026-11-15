import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { seedAgent, seedUser, seedWorkspace } from './support/workspace-admin-db'

const url = disposableDatabase()
if (url && [process.env.MIKKA_DATABASE_URL, process.env.DATABASE_URL].some(value => value !== process.env.E2E_DATABASE_URL)) throw new Error('All completion test database paths must match E2E_DATABASE_URL')
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Conversation completion requires the disposable E2E database')

test('the daemon completion writer schedules a first-run title after commit and never on a replay', { skip: !url, timeout: 30_000 }, async t => {
  const reader = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
  const owner = await seedUser(reader, 'completion-title')
  const workspace = await seedWorkspace(reader, owner, [{ userId: owner, role: 'admin' }])
  const agent = await seedAgent(reader, owner)
  const device = randomUUID()
  const runs = [randomUUID(), randomUUID()]
  t.after(async () => {
    await reader.query('DELETE FROM "user" WHERE id=$1', [owner])
    await reader.end()
  })
  await reader.query('INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,\'Completion\',\'local\')', [device, owner])
  for (const run of runs) {
    await reader.query('INSERT INTO agent_runs (id,"userId","workspaceId","deviceId","agentId",status,prompt) VALUES ($1,$2,$3,$4,$5,\'running\',\'Repair login\')', [run, owner, workspace.id, device, agent])
  }

  const received: { runId: string; ownerId: string; trigger: string; status: string; finished: boolean }[] = []
  t.mock.module(new URL('../lib/thread-title-server.ts', import.meta.url).href, { namedExports: {
    writeThreadTitle: async (runId: string, ownerId: string, trigger: string) => {
      const result = await reader.query('SELECT status, "finishedAt" IS NOT NULL AS finished FROM agent_runs WHERE id=$1', [runId])
      received.push({ runId, ownerId, trigger, ...result.rows[0] })
    },
  } })
  const { persistRunCompletion } = await import('../lib/run-publications')
  for (const runId of [runs[0], runs[0], runs[1]]) {
    assert.ok(await persistRunCompletion(owner, runId, { stopReason: 'timeout' }, device))
  }
  const deadline = Date.now() + 4_000
  while (received.length < runs.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(received.sort((a, b) => a.runId.localeCompare(b.runId)), [...runs].sort().map(runId => ({
    runId, ownerId: owner, trigger: 'first_run_ended', status: 'failed', finished: true,
  })))
})
