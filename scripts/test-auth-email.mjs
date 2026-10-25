// Cloud Linux only. No external provider, application database, or mail credentials.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'

if (process.platform !== 'linux') throw new Error('Authentication acceptance requires cloud Linux')
const suffix = randomUUID()
const name = `mikka-auth-email-${suffix}`
const password = `synthetic-${suffix}`
const run = (args, options = {}) => {
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 180_000, ...options })
  if (result.error || result.status !== 0) throw new Error(`Authentication test subprocess failed: ${args[0]}`)
  return result.stdout?.trim() ?? ''
}
let pool
try {
  run(['docker', 'run', '-d', '--rm', '--name', name, '--memory=256m', '--cpus=1',
    '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=mikka_test', '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', 'POSTGRES_DB=mikka_auth_email_e2e', 'postgres:17-alpine'])
  const port = run(['docker', 'port', name, '5432/tcp']).split(':').at(-1)
  const url = `postgresql://mikka_test:${password}@127.0.0.1:${port}/mikka_auth_email_e2e`
  pool = new Pool({ connectionString: url, connectionTimeoutMillis: 500 })
  let ready = false
  for (let i = 0; i < 40; i++) {
    try { await pool.query('select 1'); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  if (!ready) throw new Error('Isolated authentication Postgres did not start')
  await pool.end(); pool = undefined
  run([process.execPath, '--import', 'tsx', '--test', 'lib/auth-email.test.ts'], {
    stdio: 'inherit', env: { PATH: process.env.PATH, AUTH_EMAIL_TEST_DATABASE_URL: url },
  })
} finally {
  await pool?.end()
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10_000 })
}
