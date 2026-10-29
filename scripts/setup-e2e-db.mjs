import { Pool } from 'pg'
import { readFile } from 'node:fs/promises'
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

const authPool = new Pool({ connectionString, max: 1 })
try {
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
  // Runtime infrastructure uses reviewed SQL migrations rather than Drizzle
  // table definitions. Claim now reads its CLI policy, including legacy runs;
  // apply those same additive dependencies in the isolated E2E DB.
  for (const name of ['20261027164501_cloud_computers.sql', '20261027164502_computer_run_bindings.sql', '20261027164510_local_computer_reviews.sql', '20261027164511_cloud_device_scope.sql', '20261027164512_cloud_worker_leases.sql', '20261027164513_computer_run_approvals.sql', '20261027164514_bot_cloud_runtimes.sql', '20261027164515_workspace_computer_policy.sql', '20261027181000_agent_kit.sql', '20261029011700_agent_tool_approvals.sql', '20261029011701_cli_run_policy.sql']) {
    await pool.query(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'))
  }
  for (const statement of postgresSchemaStatements) await pool.query(statement)
  console.log('独立 E2E 数据库已就绪；认证表使用 Better Auth 迁移，业务表来自现有 Drizzle schema。')
} finally {
  await pool.end()
}
