// Applies one SQL file to the Mikka issue database on a direct Neon connection.
// The deployment migration runner is in scripts/migrate.mjs.
//
//   node --env-file=.env.local scripts/apply-sql.mjs drizzle/0001_agents_devices.sql
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'

const file = process.argv[2]
if (!file) {
  console.error('usage: node --env-file=.env.local scripts/apply-sql.mjs <file.sql>')
  process.exit(1)
}
const configuredUrl = process.env.MIKKA_DATABASE_URL_UNPOOLED
  ?? process.env.MIKKA_DATABASE_URL
if (!configuredUrl) {
  console.error('MIKKA_DATABASE_URL is not set (pass --env-file=.env.local)')
  process.exit(1)
}

const directUrl = new URL(configuredUrl)
directUrl.hostname = directUrl.hostname.replace(/-pooler(?=\.)/, '')
const pool = new Pool({ connectionString: directUrl.toString(), max: 1 })
try {
  const [{ database, branch }] = (await pool.query("select current_database() as database, current_setting('neon.branch_id', true) as branch")).rows
  console.log(`target ${database} (${branch ?? 'non-Neon Postgres'})`)
  await pool.query(readFileSync(file, 'utf8'))
  console.log(`applied ${file}`)
} catch (error) {
  console.error(`failed to apply ${file}: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
