import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { fixtureDatabase } from './guard.mjs'
import { seedFixture } from './seed.mjs'
import { FIXTURE_SCENARIOS, FIXTURE_TIME } from './scenarios.mjs'

const database = fixtureDatabase(), pool = new pg.Pool({ connectionString: database.href, max: 1 })
try {
  const env = { ...process.env, BETTER_AUTH_SECRET: randomBytes(32).toString('base64url') }
  for (const name of FIXTURE_SCENARIOS) {
    const seeded = await seedFixture(pool, name, env)
    const tasks = (await pool.query('SELECT status,"createdAt" FROM issues WHERE "workspaceId"=$1', [seeded.workspaceId])).rows
    assert.equal(tasks.length, name === 'empty' ? 0 : 8)
    assert.ok(tasks.every(task => task.createdAt.toISOString() === FIXTURE_TIME))
    const states = (await pool.query('SELECT category,name FROM workspace_issue_states WHERE workspace_id=$1', [seeded.workspaceId])).rows
    assert.equal(states.length, 8)
    assert.ok(states.some(state => state.name === '质量验收' && state.category === 'review'))
    console.log(JSON.stringify({ fixture: name, seeded: true, tasks: tasks.length, states: states.length }))
  }
} catch (error) {
  // PostgreSQL errors may retain parameters: never print the error object/message.
  const missingColumn = /^column "([a-zA-Z_][a-zA-Z_0-9]*)"(?: of relation "([a-zA-Z_][a-zA-Z_0-9]*)")? does not exist$/.exec(error.message ?? '')
  console.error(JSON.stringify({ fixtureSeedFailed: true, type: error.name, code: error.code, stage: error.fixtureStage,
    table: error.table ?? missingColumn?.[2], column: error.column ?? missingColumn?.[1], constraint: error.constraint }))
  process.exitCode = 1
} finally { await pool.end() }
