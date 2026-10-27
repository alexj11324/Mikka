import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'

test('the legacy artifact migration preserves data and foreign keys alongside mainline tables', async () => {
  const target = new URL(process.env.E2E_DATABASE_URL)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname.endsWith('_e2e'))
  const pool = new Pool({ connectionString: target.toString(), max: 1 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const schema = `artifact_compat_${randomUUID().replaceAll('-', '')}`
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET LOCAL search_path TO "${schema}"`)
    await client.query('CREATE TABLE issues (id uuid PRIMARY KEY); CREATE TABLE agent_runs (id uuid PRIMARY KEY); CREATE TABLE artifacts (id uuid PRIMARY KEY,"conversationId" uuid NOT NULL); CREATE TABLE artifact_versions (id uuid PRIMARY KEY,"artifactId" uuid NOT NULL REFERENCES artifacts(id),"baseVersionId" uuid); CREATE TABLE artifact_threads (id uuid PRIMARY KEY,"artifactId" uuid NOT NULL REFERENCES artifacts(id))')
    const id = randomUUID()
    await client.query('INSERT INTO artifacts VALUES ($1,$2)', [id, randomUUID()])
    await client.query('INSERT INTO artifact_versions (id,"artifactId") VALUES ($1,$2)', [randomUUID(), id])
    await client.query('INSERT INTO artifact_threads (id,"artifactId") VALUES ($1,$2)', [randomUUID(), id])
    const compatibility = await readFile(new URL('../drizzle/20261027040459_artifact_legacy_compat.sql', import.meta.url), 'utf8')
    await client.query(compatibility)
    await client.query(await readFile(new URL('../drizzle/20261027010100_artifacts.sql', import.meta.url), 'utf8'))
    await client.query(compatibility)
    const result = (await client.query(`SELECT (SELECT count(*)::int FROM mikka_legacy_artifacts_20261027) AS old_artifacts,
      (SELECT count(*)::int FROM mikka_legacy_artifact_versions_20261027) AS old_versions,
      (SELECT count(*)::int FROM artifacts) AS new_artifacts,
      (SELECT count(*)::int FROM pg_constraint WHERE conrelid='artifact_threads'::regclass AND confrelid='mikka_legacy_artifacts_20261027'::regclass) AS preserved_fk`)).rows[0]
    assert.deepEqual(result, { old_artifacts: 1, old_versions: 1, new_artifacts: 0, preserved_fk: 1 })
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  }
})
