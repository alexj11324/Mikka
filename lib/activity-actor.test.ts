import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { actingContext, activityActor, agentActor, mcpAuthActor, systemActor, userActor } from './activity-actor'

test('a signed-in write records the person as the actor', () => {
  assert.deepEqual(activityActor('u1'), { actorType: 'user', actorId: 'u1' })
})

test('an MCP agent acting for the person is recorded as the agent', async () => {
  await actingContext.run({ userId: 'u1', actor: agentActor('client-1') }, async () => {
    await Promise.resolve()
    assert.deepEqual(activityActor('u1'), { actorType: 'agent', actorId: 'client-1' })
  })
  assert.deepEqual(activityActor('u1'), userActor('u1'), 'context does not leak out of actAs')
})

test('actAs without an actor still records the person', async () => {
  await actingContext.run({ userId: 'u1' }, async () => assert.deepEqual(activityActor('u1'), userActor('u1')))
})

test('the agent actor only applies to the user it acts for', async () => {
  await actingContext.run({ userId: 'u1', actor: agentActor('client-1') }, async () => assert.deepEqual(activityActor('u2'), userActor('u2')))
})

test('an MCP write with a run token records the run\'s agents.id', () => {
  assert.deepEqual(mcpAuthActor({ clientId: 'run:r1', extra: { userId: 'u1', runId: 'r1', agentId: 'agent-uuid' } }), agentActor('agent-uuid'))
})

test('an OAuth client with no run keeps its client id', () => {
  assert.deepEqual(mcpAuthActor({ clientId: 'client-1', extra: { userId: 'u1' } }), agentActor('client-1'))
  assert.deepEqual(mcpAuthActor(undefined), agentActor(null))
})

test('verifyRunToken joins agent_runs.agentId into the auth info', () => {
  const source = readFileSync('lib/mcp/worker.ts', 'utf8')
  assert.match(source, /agentId: agentRuns\.agentId/)
  assert.match(source, /extra: \{[^}]*agentId: row\.agentId/)
})

test('system actor', () => {
  assert.deepEqual(systemActor('linear'), { actorType: 'system', actorId: 'linear' })
})

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [path] : []
  })
}

test('every issue_versions insert on the server sets the actor', () => {
  const writes = ['app', 'lib'].flatMap(sources).flatMap(path => {
    const text = readFileSync(path, 'utf8')
    return [...text.matchAll(/insert\(issueVersions\)\.values\(\{/g)].map(match => {
      const end = text.indexOf('})', match.index)
      return { path, body: text.slice(match.index, end) }
    })
  })
  assert.ok(writes.length >= 8, `found ${writes.length} writes`)
  for (const write of writes) assert.match(write.body, /\.\.\.(activityActor|systemActor|userActor|agentActor|actor)\b/, `${write.path} writes issue_versions without an actor`)
})

test('the migration is timestamp-named, later than 20261023040300, and idempotent', () => {
  const name = readdirSync('drizzle').find(file => file.endsWith('_activity_version_actor.sql'))!
  assert.match(name, /^\d{14}_/)
  assert.ok(name.slice(0, 14) > '20261023040300')
  const sql = readFileSync(join('drizzle', name), 'utf8')
  assert.equal((sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length, 4, 'two in the merge branch, two for a fresh table')
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "actorType"/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "actorId"/)
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /ADD COLUMN IF NOT EXISTS actor_/)
  assert.doesNotMatch(sql, /DROP CONSTRAINT/, 'constraints are added once, not dropped and re-added')
  for (const check of ['issue_versions_actor_type_check', 'issue_versions_actor_id_needs_type_check']) {
    assert.match(sql, new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_constraint WHERE conrelid = 'issue_versions'::regclass AND conname = '${check}'\\) THEN\\s*ALTER TABLE issue_versions ADD CONSTRAINT ${check} CHECK .* NOT VALID;`))
    assert.match(sql, new RegExp(`VALIDATE CONSTRAINT ${check};`))
  }
  assert.doesNotMatch(sql, /coalesce\(/, 'never mix a camel value with a snake value')
  assert.match(sql, /WHERE "actorType" IS NULL AND "actorId" IS NULL/, 'snake pair copied only where both camel columns are NULL')
  assert.match(sql, /whole file runs in ONE transaction/)
  assert.doesNotMatch(sql, /no long lock/)
  assert.match(sql, /CHECK \("actorId" IS NULL OR "actorType" IS NOT NULL\)/)
})

// Dev-local DB test: the migration on every pre-existing column layout, run twice, in a scratch
// schema inside a rolled-back transaction (SET LOCAL, so nothing leaks through the pooled bridge).
const databaseUrl = process.env.MIKKA_DATABASE_URL
if (!databaseUrl && process.env.REQUIRE_DB === '1') test('database required', () => assert.fail('REQUIRE_DB=1 but no MIKKA_DATABASE_URL'))
test('actor migration: fresh, snake, both and half-migrated layouts', { skip: databaseUrl ? false : 'no database' }, async () => {
  const { default: pg } = await import('pg')
  const name = readdirSync('drizzle').find(file => file.endsWith('_activity_version_actor.sql'))!
  const file = readFileSync(join('drizzle', name), 'utf8')
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  const cases: [string, string, string[], unknown[]][] = [
    ['fresh', '', [], []],
    ['snake only', 'actor_type text, actor_id text', [`'user','u1'`, 'null,null'], [['user', 'u1'], [null, null]]],
    ['both spellings', 'actor_type text, actor_id text, "actorType" text, "actorId" text', [`'user','u1',null,null`, `'user','u2','agent','a2'`], [['user', 'u1'], ['agent', 'a2']]],
    // Half-migrated: merged first, so actor_id is not renamed into place ahead of actor_type.
    ['camel type + snake pair', 'actor_type text, actor_id text, "actorType" text', [`'user','u1',null`, `'agent','a2','system'`], [['user', 'u1'], ['system', null]]],
    ['camel id + snake pair', 'actor_type text, actor_id text, "actorId" text', [`'user','u1',null`], [['user', 'u1']]],
    ['camel type + snake id', 'actor_id text, "actorType" text', [`'u1',null`, `'u2','user'`], [[null, null], ['user', null]]],
  ]
  try {
    for (const [label, cols, rows, expected] of cases) {
      await client.query('begin')
      try {
        const schema = `mik17_${process.pid}_${label.replace(/\W+/g, '_')}`
        await client.query(`create schema ${schema}`)
        await client.query(`set local search_path to ${schema}`)
        await client.query(`create table issue_versions (id serial primary key${cols ? ', ' + cols : ''})`)
        for (const row of rows) await client.query(`insert into issue_versions (${cols.replace(/ text/g, '')}) values (${row})`)
        await client.query(file)
        await client.query(file)
        const { rows: out } = await client.query('select "actorType", "actorId" from issue_versions order by id')
        assert.deepEqual(out.map(r => [r.actorType, r.actorId]), expected, label)
        const { rows: snake } = await client.query(`select column_name from information_schema.columns where table_schema = $1 and column_name like 'actor\\_%'`, [schema])
        assert.deepEqual(snake, [], `${label}: snake columns dropped`)
      } finally {
        await client.query('rollback')
      }
    }
  } finally {
    await client.end()
  }
})
