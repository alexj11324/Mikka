import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { factoryReconcilePendingSql, pendingFactoryReconciliation } from './reconcile-pending'

test('Factory eligibility uses the unchanged scoped reconciliation sweep and bound parameters', async () => {
  const expected = `t.stage IN ('spec','execute','review','verify','monitor') AND (t.status='running' OR
    (t.status='pending' AND EXISTS(SELECT 1 FROM factory_events f WHERE f."taskId"=t.id AND f.request->>'kind'='request_epoch' AND f.request->>'sourceEventId'=t."sourceEventId"::text)) OR
    (t.status='failed' AND EXISTS (SELECT 1 FROM factory_attempts a JOIN agent_runs r ON r."retryOf"=a."runId" WHERE a.id=t."attemptId")))`
  assert.equal(factoryReconcilePendingSql, expected)
  const calls: { sql: string; values: unknown[] }[] = []
  const rows = [{ id: 'existing-pending-task' }]
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values })
    return { rows }
  } } as unknown as Pick<Pool, 'query'>
  assert.equal(await pendingFactoryReconciliation(pool, 'first-owner', 'first-bot'), rows)
  assert.equal(await pendingFactoryReconciliation(pool, 'second-owner', null), rows)
  assert.deepEqual(calls.map(call => call.values), [['first-owner', 'first-bot'], ['second-owner', null]])
  assert(calls.every(call => call.sql === `SELECT t.id FROM factory_tasks t WHERE t."userId"=$1 AND t."botId" IS NOT DISTINCT FROM $2::uuid AND ${expected} ORDER BY t."updatedAt" LIMIT 50`))
})

test('Factory eligibility propagates the current store failure', async () => {
  const denied = new Error('fixture store refusal')
  const pool = { query: async () => { throw denied } } as unknown as Pick<Pool, 'query'>
  await assert.rejects(pendingFactoryReconciliation(pool, 'owner', 'bot'), error => error === denied)
})
