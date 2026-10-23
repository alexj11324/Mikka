import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import test from 'node:test'
import { Pool } from 'pg'
import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import * as issueSchema from '../lib/db/schema.ts'
import * as workspaceSchema from '../lib/db/workspace-schema.ts'
import * as projectSchema from '../lib/db/project-schema.ts'
import * as teamSchema from '../lib/db/team-schema.ts'
import { APPLICATION_BASELINE } from '../scripts/migration-order.mjs'

const run = promisify(execFile)
const directory = new URL('../drizzle/', import.meta.url)
const enabled = process.env.MIGRATION_BOOTSTRAP_CI === '1'

// Never default to DATABASE_URL or a developer/production service. The workflow
// opts in only against its disposable postgres:17 service, before E2E setup.
function ciTarget() {
  assert.equal(process.env.CI, 'true', 'Database regression is CI-only')
  const target = new URL(process.env.E2E_DATABASE_URL)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'Requires loopback CI Postgres')
  assert.equal(target.pathname, '/mikka_e2e', 'Requires the workflow temporary mikka_e2e database')
  return target
}

function schemaURL(target, schema) {
  const url = new URL(target)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

async function migrate(application, workspace) {
  const { stdout } = await run('pnpm', ['migrate'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, MIKKA_DATABASE_URL: application, DATABASE_URL: workspace,
      MIGRATE: '1', MIKKA_RUN_MIGRATIONS: '1', VERCEL: '', VERCEL_ENV: '' },
    timeout: 60000,
  })
  return stdout
}

async function snapshot(pool) {
  return {
    columns: (await pool.query(`select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema = current_schema() order by table_name, ordinal_position`)).rows,
    indexes: (await pool.query(`select tablename, indexname, indexdef from pg_indexes
      where schemaname = current_schema() order by tablename, indexname`)).rows,
    history: (await pool.query('select * from schema_migrations order by name')).rows,
  }
}

async function assertSchema(pool, modules) {
  for (const table of modules.flatMap(module => Object.values(module)).filter(value => is(value, PgTable))) {
    const config = getTableConfig(table)
    const { rows } = await pool.query(`select column_name, is_nullable from information_schema.columns
      where table_schema = current_schema() and table_name = $1`, [config.name])
    for (const column of config.columns) {
      const actual = rows.find(row => row.column_name === column.name)
      assert.ok(actual, `Missing ${config.name}.${column.name}`)
      assert.equal(actual.is_nullable, column.notNull ? 'NO' : 'YES', `${config.name}.${column.name} nullability`)
    }
  }
}

for (const separateTargets of [false, true]) {
  test(`pnpm migrate bootstraps empty ${separateTargets ? 'separate targets' : 'shared target'} and safely reruns`, {
    skip: !enabled, timeout: 180000,
  }, async () => {
    const target = ciTarget()
    const admin = new Pool({ connectionString: target.toString(), max: 1 })
    const applicationSchema = `bootstrap_app_${randomUUID().replaceAll('-', '')}`
    const workspaceSchemaName = separateTargets ? `bootstrap_ws_${randomUUID().replaceAll('-', '')}` : applicationSchema
    const schemas = [...new Set([applicationSchema, workspaceSchemaName])]
    const applicationURL = schemaURL(target, applicationSchema)
    const workspaceURL = schemaURL(target, workspaceSchemaName)
    const app = new Pool({ connectionString: applicationURL, max: 1 })
    const workspace = new Pool({ connectionString: workspaceURL, max: 1 })
    try {
      assert.equal((await admin.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
      for (const schema of schemas) await admin.query(`create schema "${schema}"`)
      // No setup-e2e-db, Better Auth migrator or schema push is called here.
      assert.deepEqual((await app.query(`select tablename from pg_tables where schemaname = current_schema()`)).rows, [])
      assert.match(await migrate(applicationURL, workspaceURL), new RegExp(`applied ${APPLICATION_BASELINE}`))
      await assertSchema(app, [issueSchema])
      await assertSchema(workspace, [workspaceSchema, projectSchema, teamSchema])
      for (const name of ['session', 'account', 'verification', 'oauthRefreshToken', 'oauthAccessToken', 'oauthConsent', 'chat_state_locks', 'chat_state_queues']) {
        assert.ok((await app.query('select to_regclass($1) as relation', [`"${name}"`])).rows[0].relation, `Missing ${name}`)
      }
      const files = (await readdir(directory)).filter(name => name.endsWith('.sql'))
      const expected = { MIKKA_DATABASE_URL: [], DATABASE_URL: [] }
      for (const file of files) {
        const sql = await readFile(new URL(file, directory), 'utf8')
        expected[/^--\s*target:\s*(\w+)/m.exec(sql)?.[1] ?? 'MIKKA_DATABASE_URL'].push(file)
      }
      for (const [pool, names] of [[app, separateTargets ? expected.MIKKA_DATABASE_URL : files], [workspace, separateTargets ? expected.DATABASE_URL : files]]) {
        assert.deepEqual((await pool.query('select name from schema_migrations order by name')).rows.map(row => row.name), names.sort())
      }
      await app.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        values ('existing-owner', 'Existing owner', 'existing@example.invalid', false, now(), now())`)
      const issue = randomUUID()
      await app.query(`insert into issues (id, "userId", title, content, status, priority)
        values ($1, 'existing-owner', 'Keep this issue', '{"type":"doc"}', 'todo', 'medium')`, [issue])
      const userBefore = (await app.query('select * from "user"')).rows
      const issueBefore = (await app.query('select * from issues')).rows
      const before = [await snapshot(app), await snapshot(workspace)]
      assert.doesNotMatch(await migrate(applicationURL, workspaceURL), /migrate: applied/)
      assert.deepEqual([await snapshot(app), await snapshot(workspace)], before, 'Rerun must leave schema/history unchanged')
      // Existing installations receive the new baseline too. Exercise its SQL
      // twice with populated tables, not merely the ledger's skip path.
      const baseline = await readFile(new URL(APPLICATION_BASELINE, directory), 'utf8')
      await app.query(baseline)
      await app.query(baseline)
      assert.deepEqual([await snapshot(app), await snapshot(workspace)], before, 'Baseline must not rewrite existing schema')
      assert.deepEqual((await app.query('select * from "user"')).rows, userBefore)
      assert.deepEqual((await app.query('select * from issues')).rows, issueBefore)
      console.log(`Verified ${files.length} migrations from empty CI schema, current app/workspace columns, rerun ledger, and populated baseline replay (${separateTargets ? 'split' : 'shared'})`)
    } finally {
      await app.end()
      await workspace.end()
      for (const schema of schemas) await admin.query(`drop schema if exists "${schema}" cascade`)
      await admin.end()
    }
  })
}
