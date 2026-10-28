// Applies pending drizzle/*.sql files in order and records each one, so a
// file runs once per database. Invoke separately with `pnpm migrate` after
// approving the target and SQL manifest. Default `pnpm build` never invokes it.
// Explicit invocation runs in Vercel production or with MIGRATE=1; MIGRATE=0
// skips before reading files or opening a database.
//
// A file targets MIKKA_DATABASE_URL unless its first lines contain
// `-- target: DATABASE_URL` (the workspace database).
import { readdirSync, readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { alreadyApplied, orderMigrations } from './migration-order.mjs'
import { scopeMigrationBeforeCommit, validateScopeMigrationHistory, validateScopeMigrationSources } from './scope-migration-history.mjs'

const shouldRun = process.env.MIGRATE !== '0' && (process.env.MIGRATE === '1' || process.env.VERCEL_ENV === 'production')
if (!shouldRun) {
  console.log('migrate: skipped (explicit MIGRATE=0 or non-production; set MIGRATE=1 to apply)')
  process.exit(0)
}

const targets = {
  MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL,
  DATABASE_URL: process.env.DATABASE_URL,
}

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
  const target = /^--\s*target:\s*(\w+)/m.exec(sql)?.[1] ?? 'MIKKA_DATABASE_URL'
  if (!(target in targets)) throw new Error(`migrate: ${name} names unknown target ${target}`)
  if (!byTarget.has(target)) byTarget.set(target, [])
  byTarget.get(target).push({ name, sql })
}

validateScopeMigrationSources([...byTarget.values()].flat())
for (const target of byTarget.keys()) if (!targets[target]) throw new Error(`migrate: ${target} is not set`)
const states = []
try {
  // Read and validate every target before any pending migration is executed.
  // Commits remain per file/target: this is not a distributed transaction.
  for (const [target, pending] of byTarget) {
    const pool = new Pool({ connectionString: targets[target], max: 1 })
    const state = { target, pending, pool }
    states.push(state)
    await pool.query('create table if not exists schema_migrations (name text primary key, "appliedAt" timestamptz not null default now())')
    const { rows } = await pool.query('select name from schema_migrations')
    state.applied = new Set(rows.map((row) => row.name))
  }
  for (const { pending, applied } of states) validateScopeMigrationHistory(pending, applied)
  for (const { target, pending, pool, applied } of states) {
    for (const { name, sql } of pending) {
      if (alreadyApplied(name, applied, sql)) continue
      const scopeBeforeCommit = scopeMigrationBeforeCommit(name, sql)
      const client = await pool.connect()
      try {
        // Only the hash-pinned scope files defer their outer COMMIT until the
        // ledger is written. Other migrations retain main's execution rules.
        await client.query(scopeBeforeCommit ?? sql)
        await client.query('insert into schema_migrations (name) values ($1)', [name])
        if (scopeBeforeCommit !== null) await client.query('COMMIT')
        console.log(`migrate: applied ${name} to ${target}`)
      } catch (error) {
        if (scopeBeforeCommit !== null) {
          try { await client.query('ROLLBACK') } catch { /* Preserve the original outcome; never retry here. */ }
        }
        throw error
      } finally {
        client.release()
      }
    }
  }
} finally {
  await Promise.all(states.map(({ pool }) => pool.end()))
}
