import assert from 'node:assert/strict'
import test from 'node:test'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { agentRuns } from './db/schema'
import { runTaskPrompt, threadNameLines } from './run-bot-name'
import { dbUrl } from '../tests/support/workspace-admin-db'

test('thread lists read only the recorded task range in real PostgreSQL, never an unknown execution prompt', { skip: !dbUrl }, async () => {
  const pool = new Pool({ connectionString: dbUrl, max: 1 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Connection-local table shadows the application table; no shared fixture or schema is changed.
    await client.query('CREATE TEMP TABLE agent_runs (id uuid, prompt text, "promptTaskStart" integer, "promptTaskLength" integer) ON COMMIT DROP')
    const prefix = 'INTERNAL_HOST_GUIDANCE 🔍\n\n', task = 'User task 🧪\nUser body'
    await client.query('INSERT INTO agent_runs VALUES (gen_random_uuid(),$1,$2,$3), (gen_random_uuid(),$1,NULL,NULL), (gen_random_uuid(),$1,0,999999), (gen_random_uuid(),$1,0,0)',
      [prefix + task + '\nINTERNAL_STANDING_INSTRUCTION', Array.from(prefix).length, Array.from(task).length])
    const rows = await drizzle(client).select({ task: runTaskPrompt, name: threadNameLines }).from(agentRuns)
    assert.deepEqual(rows.map(row => row.task).sort(), ['', '', '', task].sort())
    assert.deepEqual(rows.map(row => row.name).filter(Boolean), ['User task 🧪'])
    // Partial ranges, negative values and int32-overflow sums must all fail
    // closed. PostgreSQL LEAST ignores NULL, so test each missing half too.
    await client.query('TRUNCATE agent_runs')
    for (const [start, length] of [[null, 4], [0, null], [-1, 4], [0, -1], [2147483647, 1], [1, 2147483647], [2147483647, 2147483647], [-2147483648, 2147483647], [2147483647, -2147483648]]) {
      await client.query('INSERT INTO agent_runs VALUES (gen_random_uuid(),$1,$2,$3)', ['INTERNAL_HOST_GUIDANCE', start, length])
    }
    const invalid = await drizzle(client).select({ task: runTaskPrompt, name: threadNameLines }).from(agentRuns)
    assert.deepEqual(invalid.map(row => row.task), Array(9).fill(''))
    assert.ok(invalid.every(row => !row.name))
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  }
})
