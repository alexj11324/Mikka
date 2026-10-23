// Applies pending drizzle/*.sql files in order and records each one, so a
// file runs once per database. Runs as part of `pnpm build`, but only for
// Vercel production builds unless MIGRATE=1 is set; preview and local builds
// skip it.
//
// A file targets MIKKA_DATABASE_URL unless its header (leading comment lines)
// contains `-- target: DATABASE_URL` (the workspace database). A file with
// `-- migrate: no-transaction` in its header holds one statement run outside a
// transaction; see scripts/migration-steps.mjs for the rules.
import { readdirSync, readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { applyMigration, planMigration } from './migration-steps.mjs'

const shouldRun = process.env.MIGRATE === '1' || process.env.VERCEL_ENV === 'production'
if (!shouldRun) {
  console.log('migrate: skipped (not a Vercel production build; set MIGRATE=1 to force)')
  process.exit(0)
}

const targets = {
  // ORVILO_DATABASE_URL is the pre-rename name.
  MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL ?? process.env.ORVILO_DATABASE_URL,
  DATABASE_URL: process.env.DATABASE_URL,
}

const dir = new URL('../drizzle/', import.meta.url)
// 旧迁移是 NNNN_*.sql，新迁移是 YYYYMMDDHHMMSS_*.sql（UTC）。按文件名排序时时间戳文件排在所有旧文件之后。
// 其它 .sql 文件名直接报错，避免迁移被静默跳过。
const sqlFiles = readdirSync(dir).filter((name) => name.endsWith('.sql'))
const unknown = sqlFiles.filter((name) => !/^(\d{4}|\d{14})_.+\.sql$/.test(name))
if (unknown.length) throw new Error(`migrate: 无法识别的迁移文件名：${unknown.join(', ')}`)
const files = sqlFiles.sort()

const byTarget = new Map()
for (const name of files) {
  const sql = readFileSync(new URL(name, dir), 'utf8')
  // Validated up front so a bad file fails before anything is applied.
  const plan = planMigration(name, sql)
  const target = plan.target
  if (!(target in targets)) throw new Error(`migrate: ${name} names unknown target ${target}`)
  if (!byTarget.has(target)) byTarget.set(target, [])
  byTarget.get(target).push({ name, plan })
}

for (const [target, pending] of byTarget) {
  const url = targets[target]
  if (!url) throw new Error(`migrate: ${target} is not set`)
  const pool = new Pool({ connectionString: url, max: 1 })
  try {
    await pool.query('create table if not exists schema_migrations (name text primary key, "appliedAt" timestamptz not null default now())')
    const { rows } = await pool.query('select name from schema_migrations')
    const applied = new Set(rows.map((row) => row.name))
    for (const { name, plan } of pending) {
      if (applied.has(name)) continue
      const client = await pool.connect()
      try {
        await applyMigration(client, name, plan)
        console.log(`migrate: applied ${name} to ${target}`)
      } finally {
        client.release()
      }
    }
  } finally {
    await pool.end()
  }
}
