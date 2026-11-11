// Applies pending drizzle/*.sql files in order and records each one, so a
// file runs once per database. `pnpm build` runs it last, after the application build
// succeeds, so a Vercel production deploy applies pending migrations itself
// (Alex, 2026-10-30). It runs in Vercel production, with MIGRATE=1, or off
// Vercel when every configured target is a loopback database; MIGRATE=0 skips
// before reading files or opening a database.
//
// A file targets MIKKA_DATABASE_URL unless its first lines contain
// `-- target: DATABASE_URL` (the workspace database). In Preview both targets
// resolve to its explicit DATABASE_URL. A leading header can also declare
// `-- migrate: no-transaction` for one standalone statement.
import { readdirSync, readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { directDatabaseURL } from './postgres-connection.mjs'
import { alreadyApplied, orderMigrations } from './migration-order.mjs'
import { applyMigration, planMigration } from './migration-steps.mjs'
import { migrationTargets } from './migration-targets.mjs'
import { migrationGuard, migrationRequested } from './migration-guard.mjs'
import { scopeMigrationBeforeCommit, validateScopeMigrationHistory, validateScopeMigrationSources } from './scope-migration-history.mjs'

// Targets are resolved only when they can decide: MIGRATE=0 and an unrequested
// Vercel build skip first (Preview's resolution throws without its database).
const env = process.env
const mayRun = env.MIGRATE !== '0' && (env.MIGRATE === '1' || env.VERCEL_ENV === 'production' || (!env.VERCEL && !env.VERCEL_ENV))
const targets = mayRun ? migrationTargets(env) : {}
if (!migrationRequested(env, targets)) {
  console.log('migrate: skipped (explicit MIGRATE=0, or a non-production remote database; set MIGRATE=1 to apply)')
  process.exit(0)
}

// This marks entry into the requested command, before guards or database work.
console.log('migrate: starting')
const { warning } = migrationGuard(process.env, targets, process.argv.slice(2))
if (warning) console.warn(warning)

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
    const pool = new Pool({ connectionString: directDatabaseURL(targets[target]), max: 1, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 20_000 })
    pool.on?.('error', () => console.warn('migration_idle_connection_lost'))
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
  const application = states.find(state => state.target === 'MIKKA_DATABASE_URL')?.pool
  const workspace = states.find(state => state.target === 'DATABASE_URL')?.pool
  if (application && workspace && files.includes('20261109035000_task_workspace_ownership.sql')) {
    const { backfillTaskWorkspaces } = await import('./task-workspace-backfill.mjs')
    const ownership = await backfillTaskWorkspaces(application, workspace)
    console.log(`migrate: task workspace ownership bound=${ownership.bound} pending=${ownership.pending}`)
    if (files.includes('20261111030001_task_identity.sql') && files.includes('20261111030002_task_identity_aliases.sql')) {
      const { backfillTaskIdentifiers } = await import('./task-identity-backfill.mjs')
      const identifiers = await backfillTaskIdentifiers(application, workspace)
      console.log(`migrate: stable task identifiers issued=${identifiers.issued}`)
    }
    if (files.includes('20261111030000_project_v2.sql')) {
      const { backfillProjectV2 } = await import('./project-v2-backfill.mjs')
      const projects = await backfillProjectV2(application, workspace)
      console.log(`migrate: projects bound=${projects.projectsBound} tasks=${projects.projectTasksBound} pending=${projects.projectsPending}`)
    }
  }
  if (application && workspace && files.includes('20261110150005_resource_acl.sql')) {
    const { backfillProjectResourceAccess } = await import('./resource-acl-backfill.mjs')
    const access = await backfillProjectResourceAccess(application, workspace)
    console.log(`migrate: project ACL registered=${access.registered} quarantined=${access.quarantined} tasksBound=${access.tasksBound}`)
  }
} finally { await Promise.all(states.map(({ pool }) => pool.end())) }
