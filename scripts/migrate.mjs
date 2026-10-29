// Applies pending drizzle/*.sql files in order and records each one, so a
// file runs once per database. Invoke separately with `pnpm migrate` after
// approving the target and SQL manifest. Default `pnpm build` never invokes it.
// Explicit invocation runs in Vercel production or with MIGRATE=1; MIGRATE=0
// skips before reading files or opening a database.
//
// A file targets MIKKA_DATABASE_URL unless its first lines contain
// `-- target: DATABASE_URL` (the workspace database). In Preview both targets
// resolve to its explicit DATABASE_URL. A leading header can also declare
// `-- migrate: no-transaction` for one standalone statement.
import { readdirSync, readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { alreadyApplied, orderMigrations } from './migration-order.mjs'
import { applyMigration, planMigration } from './migration-steps.mjs'
import { migrationTargets } from './migration-targets.mjs'
import { scopeMigrationBeforeCommit, validateScopeMigrationHistory, validateScopeMigrationSources } from './scope-migration-history.mjs'

const shouldRun = process.env.MIGRATE !== '0' && (process.env.MIGRATE === '1' || process.env.VERCEL_ENV === 'production')
if (!shouldRun) {
  console.log('migrate: skipped (explicit MIGRATE=0 or non-production; set MIGRATE=1 to apply)')
  process.exit(0)
}

const targets = migrationTargets(process.env)

const dir = new URL('../drizzle/', import.meta.url)
// 旧迁移是 NNNN_*.sql，新迁移是 YYYYMMDDHHMMSS_*.sql（UTC）。按文件名排序时时间戳文件排在所有旧文件之后。
// 其它 .sql 文件名直接报错，避免迁移被静默跳过。
const sqlFiles = readdirSync(dir).filter((name) => name.endsWith('.sql'))
const unknown = sqlFiles.filter((name) => !/^(\d{4}|\d{14})_.+\.sql$/.test(name))
if (unknown.length) throw new Error(`migrate: 无法识别的迁移文件名：${unknown.join(', ')}`)
const files = orderMigrations(sqlFiles)

const byTarget = new Map()
for (const name of files) {
  const sql = readFileSync(new URL(name, dir), 'utf8')
  // Validate all files before opening any database, including already applied files.
  const plan = planMigration(name, sql)
  const target = plan.target
  if (!(target in targets)) throw new Error(`migrate: ${name} names unknown target ${target}`)
  if (!byTarget.has(target)) byTarget.set(target, [])
  byTarget.get(target).push({ name, sql, plan })
}

validateScopeMigrationSources([...byTarget.values()].flat())
for (const target of byTarget.keys()) if (!targets[target]) throw new Error(`migrate: ${target} is not set`)
const states = []
try {
  // Validate both targets' complete scope history before applying pending DDL.
  // Commits remain per file/connection, not distributed across targets.
  for (const [target, pending] of byTarget) {
    const pool = new Pool({ connectionString: targets[target], max: 1 })
    const state = { target, pending, pool }
    states.push(state)
    await pool.query('create table if not exists schema_migrations (name text primary key, "appliedAt" timestamptz not null default now())')
    const { rows } = await pool.query('select name from schema_migrations')
    state.applied = new Set(rows.map(row => row.name))
  }
  for (const { pending, applied } of states) {
    validateScopeMigrationHistory(pending, applied)
    // Resolve all aliases and ambiguous historical IDs before any pending DDL.
    for (const { name, sql } of pending) alreadyApplied(name, applied, sql)
  }
  for (const { target, pending, pool, applied } of states) {
    for (const { name, sql, plan } of pending) {
      if (alreadyApplied(name, applied, sql)) continue
      const beforeCommit = scopeMigrationBeforeCommit(name, sql)
      const client = await pool.connect()
      try {
        // The existing main executor keeps its concurrent-index validation.
        // Only the nine audited scope bodies defer COMMIT until its ledger insert.
        await applyMigration(client, name, beforeCommit === null ? plan : { ...plan, sql: beforeCommit })
        if (beforeCommit !== null) await client.query('COMMIT')
        console.log(`migrate: applied ${name} to ${target}`)
      } catch (error) {
        if (beforeCommit !== null) {
          try { await client.query('ROLLBACK') } catch { /* Keep the original, possibly uncertain outcome; never retry. */ }
        }
        throw error
      } finally { client.release() }
    }
  }
} finally { await Promise.all(states.map(({ pool }) => pool.end())) }
