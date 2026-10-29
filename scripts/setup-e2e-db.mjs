import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { Pool } from 'pg'
import { getMigrations } from 'better-auth/db/migration'
import { oauthProvider } from '@better-auth/oauth-provider'
import { postgresSchemaStatements } from '@chat-adapter/state-pg'
import { SQL, is, sql } from 'drizzle-orm'
import { getTableConfig, PgDialect, PgTable } from 'drizzle-orm/pg-core'
import * as issueSchema from '../lib/db/schema.ts'
import * as workspaceSchema from '../lib/db/workspace-schema.ts'
import * as projectSchema from '../lib/db/project-schema.ts'
import * as teamSchema from '../lib/db/team-schema.ts'

const connectionString = process.env.E2E_DATABASE_URL
if (!connectionString) throw new Error('必须设置独立的 E2E_DATABASE_URL，禁止回退到业务数据库。')
const target = new URL(connectionString)
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) {
  throw new Error('测试初始化仅允许本机且名称以 _e2e 结尾的数据库。')
}

// Bootstrap probes use disposable schemas; the app itself needs migrations on its E2E target.
execFileSync(process.execPath, ['scripts/migrate.mjs'], {
  cwd: new URL('..', import.meta.url), stdio: 'inherit',
  env: { ...process.env, MIKKA_DATABASE_URL: connectionString, DATABASE_URL: connectionString, MIGRATE: '1' },
})

const authPool = new Pool({ connectionString, max: 1 })
try {
  const expected = readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()
  const applied = (await authPool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(row => row.name)
  assert.deepEqual(applied, expected, 'The E2E app target must contain every tracked migration')
  for (const table of ['factory_questions', 'improvement_skill_candidates', 'improvement_skill_selections',
    'improvement_skill_mounts', 'improvement_benchmark_instances', 'improvement_skill_lifecycle']) {
    assert.ok((await authPool.query('SELECT to_regclass($1) AS relation', [table])).rows[0].relation,
      `Missing SQL-only E2E table: ${table}`)
  }
  // The OAuth provider's tables (drizzle/0009); its pages do not matter here.
  const migration = await getMigrations({ database: authPool, emailAndPassword: { enabled: true }, plugins: [oauthProvider({ loginPage: '/sign-in', consentPage: '/oauth/consent', disableJwtPlugin: true })] })
  await migration.runMigrations()
} finally {
  if (!authPool.ended) await authPool.end()
}

const pool = new Pool({ connectionString, max: 1 })
const dialect = new PgDialect()
const identifier = name => dialect.sqlToQuery(sql`${sql.identifier(name)}`).sql
function defaultValue(value, dataType) {
  if (value instanceof SQL) {
    const query = dialect.sqlToQuery(value)
    if (query.params.length) throw new Error('测试 DDL 不支持带参数的默认值。')
    return query.sql
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  if (dataType === 'json') return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
  throw new Error('测试 DDL 遇到未支持的默认值。')
}

try {
  const tables = [...Object.values(issueSchema), ...Object.values(workspaceSchema), ...Object.values(projectSchema), ...Object.values(teamSchema)]
  for (const table of tables.filter(value => is(value, PgTable))) {
    const config = getTableConfig(table)
    if (config.name === 'user') continue
    const columns = config.columns.map(column => [
      identifier(column.name), column.getSQLType(),
      column.notNull ? 'NOT NULL' : '',
      column.primary ? 'PRIMARY KEY' : '',
      column.isUnique ? 'UNIQUE' : '',
      column.default === undefined ? '' : `DEFAULT ${defaultValue(column.default, column.dataType)}`,
    ].filter(Boolean).join(' '))
    const constraints = [
      ...config.primaryKeys.map(key => `PRIMARY KEY (${key.columns.map(column => identifier(column.name)).join(', ')})`),
      ...config.uniqueConstraints.map(key => `UNIQUE (${key.columns.map(column => identifier(column.name)).join(', ')})`),
    ]
    await pool.query(`CREATE TABLE IF NOT EXISTS ${identifier(config.name)} (${[...columns, ...constraints].join(', ')})`)
  }
  // The complete migration runner above already applied SQL-only runtime,
  // CLI policy and Factory tables. Never replay a handwritten subset here.
  for (const statement of postgresSchemaStatements) await pool.query(statement)
  console.log('独立 E2E 数据库已就绪；认证表使用 Better Auth 迁移，业务表来自现有 Drizzle schema。')
} finally {
  await pool.end()
}
