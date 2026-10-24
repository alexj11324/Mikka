// Linux-only, disposable loopback Postgres acceptance. Never uses app env/database URLs.
import { Pool } from 'pg'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const supplied = process.env.CREDENTIAL_TEST_ADMIN_DATABASE_URL
if (!supplied) throw new Error('Set CREDENTIAL_TEST_ADMIN_DATABASE_URL to an isolated loopback Postgres /postgres database; no application URL fallback exists.')
const adminURL = new URL(supplied)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(adminURL.hostname) || adminURL.pathname !== '/postgres') throw new Error('Acceptance requires a loopback /postgres admin database.')
const suffix = randomUUID().replaceAll('-', '')
const names = [`mikka_credential_test_app_${suffix}`, `mikka_credential_test_workspace_${suffix}`]
const admin = new Pool({ connectionString: supplied, max: 1 })
const created = []
const reportDirectory = await mkdtemp(join(tmpdir(), 'mikka-credential-acceptance-'))
const root = fileURLToPath(new URL('../', import.meta.url))
try {
  for (const name of names) {
    if (!/^mikka_credential_test_[a-z0-9_]+$/.test(name)) throw new Error('Invalid fixture database name')
    await admin.query(`CREATE DATABASE "${name}"`)
    created.push(name)
  }
  const urls = names.map(name => { const url = new URL(supplied); url.pathname = `/${name}`; return url.href })
  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', 'lib/credentials/acceptance.test.ts'], {
      cwd: root, env: { ...process.env, CREDENTIAL_TEST_DATABASE_URL: urls[0], CREDENTIAL_TEST_WORKSPACE_DATABASE_URL: urls[1] },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, output }))
  })
  // A failing assertion must not print the fixture secret either.
  const source = await readFile(new URL('../lib/credentials/acceptance.test.ts', import.meta.url), 'utf8')
  const marker = /const fixture = '([^']+)'/.exec(source)?.[1]
  if (!marker || outcome.output.includes(marker)) {
    process.exitCode = 1
    await writeFile(join(reportDirectory, 'acceptance.tap'), 'FAIL: synthetic credential marker appeared in captured test output; output suppressed.\n')
    console.error('Acceptance output suppressed because its secrecy assertion failed.')
  } else {
    await writeFile(join(reportDirectory, 'acceptance.tap'), outcome.output)
    process.stdout.write(outcome.output)
    process.exitCode = outcome.code ?? 1
  }
  console.log(`Evidence: ${join(reportDirectory, 'acceptance.tap')}`)
} finally {
  // Only names created by this invocation are removed; no existing database is selected.
  for (const name of created.reverse()) await admin.query(`DROP DATABASE "${name}"`)
  await admin.end()
}
