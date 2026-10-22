// Applies one SQL file to MIKKA_DATABASE_URL. The project has no migration
// runner; this is the whole of it.
//
//   node --env-file=.env.local scripts/apply-sql.mjs drizzle/0001_agents_devices.sql
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'

const file = process.argv[2]
if (!file) {
  console.error('usage: node --env-file=.env.local scripts/apply-sql.mjs <file.sql>')
  process.exit(1)
}
// ORVILO_DATABASE_URL is the pre-rename name; existing .env.local files still use it.
const databaseUrl = process.env.MIKKA_DATABASE_URL ?? process.env.ORVILO_DATABASE_URL
if (!databaseUrl) {
  console.error('MIKKA_DATABASE_URL is not set (pass --env-file=.env.local)')
  process.exit(1)
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 })
try {
  await pool.query(readFileSync(file, 'utf8'))
  console.log(`applied ${file}`)
} catch (error) {
  console.error(`failed to apply ${file}: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
