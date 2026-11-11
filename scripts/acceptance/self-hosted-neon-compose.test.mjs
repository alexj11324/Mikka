import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// This test validates the actual published Compose file on CI's Docker Compose
// installation without connecting to Neon, running migrations or exposing URLs.
const root = fileURLToPath(new URL('../..', import.meta.url))
const pooled = 'postgresql://fixture:synthetic@ep-fixture-pooler.us-east-2.aws.neon.tech/mikka_ci?sslmode=require'
const direct = 'postgresql://fixture:synthetic@ep-fixture.us-east-2.aws.neon.tech/mikka_ci?sslmode=require'

function configuration(overrides = {}) {
  const env = {
    ...process.env,
    BETTER_AUTH_URL: 'https://mikka.example.invalid',
    MIKKA_DATABASE_URL: pooled,
    MIKKA_DATABASE_URL_UNPOOLED: direct,
    MIKKA_IMAGE: 'mikka-self-hosted:fixture',
    ...overrides,
  }
  const result = spawnSync('docker', ['compose', '-f', 'docker-compose.neon.yml', 'config', '--format', 'json'], {
    cwd: root, env, encoding: 'utf8', timeout: 20_000,
  })
  return result
}

test('external PostgreSQL Compose passes distinct pooled and direct URLs without a database container', () => {
  const result = configuration()
  assert.equal(result.status, 0, 'external PostgreSQL Compose must parse on the pinned CI Docker installation')
  const parsed = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(parsed.services), ['app'])
  const { app } = parsed.services
  assert.equal(app.environment.MIKKA_DATABASE_URL, pooled)
  assert.equal(app.environment.DATABASE_URL, pooled)
  assert.equal(app.environment.MIKKA_DATABASE_URL_UNPOOLED, direct)
  assert.equal(app.environment.BETTER_AUTH_URL, 'https://mikka.example.invalid')
  assert.equal(app.image, 'mikka-self-hosted:fixture')
  assert.equal(app.ports.length, 1)
  assert.equal(app.ports[0].host_ip, '127.0.0.1')
  assert.ok(app.volumes.some(volume => volume.target === '/data' && volume.type === 'volume'))
  assert.equal(app.depends_on, undefined)
  assert.equal(parsed.services.postgres, undefined)
})

test('external PostgreSQL Compose fails closed without pooled connection URL', () => {
  const result = configuration({ MIKKA_DATABASE_URL: '' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /MIKKA_DATABASE_URL/)
})

test('external PostgreSQL Compose fails closed without direct connection URL', () => {
  const result = configuration({ MIKKA_DATABASE_URL_UNPOOLED: '' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /MIKKA_DATABASE_URL_UNPOOLED/)
})
