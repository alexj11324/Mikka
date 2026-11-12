import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)
const docker = (...args) => exec('docker', ['--host=unix:///var/run/docker.sock', ...args], { timeout: 120_000 })

test('the isolation-checked recovery CLI replays the deletion journal from a real PG17 backup', { timeout: 240_000 }, async t => {
  const name = 'mikka-recovery-' + randomUUID()
  const directory = await mkdtemp(join(tmpdir(), 'mikka-recovery-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { stdout } = await docker('run', '--detach', '--name', name, '--publish', '127.0.0.1::5432',
    '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine')
  const container = stdout.trim()
  assert.match(container, /^[a-f0-9]{64}$/)
  t.after(() => docker('rm', '--force', '--volumes', container))
  const address = (await docker('port', container, '5432/tcp')).stdout.trim()
  assert.match(address, /^127\.0\.0\.1:\d+$/)
  // The entrypoint's bootstrap server only accepts Unix sockets.
  for (let remaining = 30; ; remaining--) {
    try {
      await docker('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres')
      break
    } catch (error) {
      if (remaining === 0) throw error
      await delay(500)
    }
  }
  const { stdout: result } = await exec(process.execPath, ['--conditions=react-server',
    '--import', './tests/support/server-only-loader.mjs', '--import', 'tsx', 'scripts/ops/drill.mjs'], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: directory,
      MIKKA_EDITION: 'community', BETTER_AUTH_URL: 'http://127.0.0.1:3100',
      BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
      OPS_POSTGRES_CONTAINER: container, OPS_POSTGRES_URL: 'postgresql://postgres@' + address + '/postgres',
    }, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  })
  const report = JSON.parse(result.trim().split('\n').at(-1))
  assert.equal(report.state, 'quarantined')
  assert.ok(report.deniedFailures.includes('pending-deletion-journal'))
  console.info('PG17 recovery CLI', { restoreDurationMs: report.restoreDurationMs, deniedFailures: report.deniedFailures })
})
