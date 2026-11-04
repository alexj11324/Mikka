import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Pool } from 'pg'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { seedAgent, seedIssue, seedRun, seedUser } from '../../tests/support/workspace-admin-db'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw Error('An isolated source database is required')

// The service suite checks real owner/peer writes. This additional schema gate
// compiles every private-source lookup, including rarely populated question,
// artifact and group tables, against the migrated isolated database.
test('all source lookup SQL compiles against the real migrated schema', { skip: !target }, async t => {
  const pool = new Pool({ connectionString: target })
  t.after(() => pool.end())
  const source = await readFile(new URL('./sources.ts', import.meta.url), 'utf8')
  const queries = [...source.matchAll(/pool\.query(?:<[\s\S]*?>)?\((?:'((?:\\.|[^'\\])*)'|`([^`]*)`)/g)]
    .map(match => match[2] ?? match[1].replace(/\\([\\'])/g, '$1'))
  assert.ok(queries.length >= 17, 'every source-specific lookup must reach the schema gate')
  for (const query of queries) {
    const count = Math.max(...[...query.matchAll(/\$(\d+)/g)].map(match => Number(match[1])))
    const values = Array.from({ length: count }, () => '00000000-0000-4000-8000-000000000001')
    const result = await pool.query('EXPLAIN (FORMAT JSON) ' + query, values)
    assert.equal(result.rows.length, 1)
    assert.ok(result.rows[0]['QUERY PLAN'])
  }
})

test('artifact source SQL attributes exact versions to their own receipts, never the latest or creator run', { skip: !target }, async t => {
  const pool = new Pool({ connectionString: target, max: 1 })
  await pool.query('BEGIN')
  t.after(async () => { try { await pool.query('ROLLBACK') } finally { await pool.end() } })
  const source = await readFile(new URL('./sources.ts', import.meta.url), 'utf8')
  const query = [...source.matchAll(/pool\.query(?:<[\s\S]*?>)?\((?:'((?:\\.|[^'\\])*)'|`([^`]*)`)/g)]
    .map(match => match[2] ?? match[1].replace(/\\([\\'])/g, '$1'))
    .find(value => value.includes('FROM artifacts a'))
  assert.ok(query, 'exercise the production version lookup')
  const owner = await seedUser(pool, 'artifact-source-owner')
  const agentId = await seedAgent(pool, owner)
  const creatorIssue = await seedIssue(pool, owner)
  const submitterIssue = await seedIssue(pool, owner)
  const creatorRun = await seedRun(pool, { userId: owner, agentId, issueId: creatorIssue })
  const submitterRun = await seedRun(pool, { userId: owner, agentId, issueId: submitterIssue })
  const artifactId = randomUUID()
  const versionIds = [randomUUID(), randomUUID(), randomUUID()]
  await pool.query('INSERT INTO artifacts (id,"userId",kind,title,"runId","issueId","latestVersion") VALUES ($1,$2,\'markdown\',\'Latest title\',$3,$4,3)', [artifactId, owner, creatorRun, creatorIssue])
  for (const [index, id] of versionIds.entries()) await pool.query('INSERT INTO artifact_versions (id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") VALUES ($1,$2,$3,\'fixture-key\',\'Version bytes\',\'fixture-sha\',13,\'Fixture author\')', [id, artifactId, index + 1])
  const eventId = randomUUID()
  const payload = { artifactId, version: 2, title: 'Second version' }
  await pool.query('INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId","runId",payload) VALUES ($1,$2,\'artifact_submitted\',$3,$4,$5,$6)', [eventId, owner, 'artifact_submitted:' + artifactId + ':2', submitterIssue, submitterRun, payload])
  const lookup = async (version: number, userId = owner) => (await pool.query(query, [artifactId, versionIds[version - 1], userId])).rows
  const [second] = await lookup(2)
  assert.equal(second.runId, submitterRun, 'v2 belongs to B, although artifacts.runId still names A')
  assert.equal(second.issueId, submitterIssue)
  assert.equal(second.title, 'Second version', 'the latest title does not describe an older submitted version')
  assert.equal((await lookup(1))[0].runId, creatorRun, 'legacy v1 alone has creator provenance')
  assert.equal((await lookup(3)).length, 0, 'a receiptless later version cannot inherit its creator')
  assert.equal((await lookup(2, 'another-owner')).length, 0)
  await pool.query('UPDATE coordinator_events SET payload=$2 WHERE id=$1', [eventId, { ...payload, version: '2' }])
  assert.equal((await lookup(2)).length, 0, 'a string version is not the host submission receipt')
  await pool.query('UPDATE coordinator_events SET payload=$2 WHERE id=$1', [eventId, payload])
  await pool.query('INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId","runId",payload) VALUES ($1,$2,\'run_finished\',$3,$4,$5,$6)', [randomUUID(), owner, 'artifact_submitted:' + artifactId + ':1', creatorIssue, creatorRun, { artifactId, version: 1 }])
  assert.equal((await lookup(1)).length, 0, 'a conflicting receipt cannot fall back to the creator')
  await pool.query('DELETE FROM agent_runs WHERE id=$1', [submitterRun])
  assert.equal((await lookup(2)).length, 0, 'a removed submitter never reattributes its later version to A')
})
