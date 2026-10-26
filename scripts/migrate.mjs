// Applies pending drizzle/*.sql files in order and records each one, so a
// file runs once per database. Runs as part of `pnpm build`, but only for
// Vercel production builds unless MIGRATE=1 is set; preview and local builds
// skip it. Explicit MIGRATE=0 skips before reading files or opening a database.
//
// A file targets MIKKA_DATABASE_URL unless its first lines contain
// `-- target: DATABASE_URL` (the workspace database).
import { readdirSync, readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { orderMigrations } from './migration-order.mjs'
import { historicalImports } from './historical-migrations.mjs'
import { searchSupersessions, executeMigration, validateSearchObject, aliasSearchMigration } from './search-migrations.mjs'
import { configureMigrationSession } from './migration-session.mjs'

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
// Fail before opening either DB, including when imported files are already in main.
const contents = new Map(sqlFiles.map(name => [name, readFileSync(new URL(name, dir))]))
historicalImports([...contents].map(([name, content]) => ({ name, content })))
const supersessions = searchSupersessions([...contents].map(([name, content]) => ({ name, content })))
const files = orderMigrations(sqlFiles)

const byTarget = new Map()
for (const name of files) {
  const sql = contents.get(name).toString('utf8')
  const target = /^--\s*target:\s*(\w+)/m.exec(sql)?.[1] ?? 'MIKKA_DATABASE_URL'
  if (!(target in targets)) throw new Error(`migrate: ${name} names unknown target ${target}`)
  if (!byTarget.has(target)) byTarget.set(target, [])
  byTarget.get(target).push({ name, sql })
}

for (const [target, pending] of byTarget) {
  const url = targets[target]
  if (!url) throw new Error(`migrate: ${target} is not set`)
  const pool = new Pool({ connectionString: url, max: 1 })
  let client
  try {
    client = await pool.connect()
    // Includes ledger DDL and reads, not only the individual migration files.
    await configureMigrationSession(client)
    await client.query("SELECT pg_advisory_lock(hashtextextended('mikka-schema-migrations',0))")
    await client.query('create table if not exists schema_migrations (name text primary key, "appliedAt" timestamptz not null default now())')
    const { rows } = await client.query('select name from schema_migrations')
    const applied = new Set(rows.map((row) => row.name))
    for (const { name, sql } of pending) {
      const entry = supersessions.find(e => e.canonicalName === name && e.target === target)
      if (applied.has(name)) {
        if (entry) await validateSearchObject(client, entry)
        continue
      }
      if (entry && applied.has(entry.legacyName)) {
        await aliasSearchMigration(client, entry)
        applied.add(name)
        console.log(`migrate: aliased ${entry.legacyName} as ${name} to ${target}`)
        continue
      }
      // Files may manage their own transaction; the record is written after.
      // A timeout throws, stops this build and never marks the file applied.
      await executeMigration(client, name, sql)
      if (entry) await validateSearchObject(client, entry)
      await client.query('insert into schema_migrations (name) values ($1)', [name])
      console.log(`migrate: applied ${name} to ${target}`)
    }
  } finally {
    // Destroy the session even if a self-managed SQL transaction was aborted.
    client?.release(true)
    await pool.end()
  }
}
