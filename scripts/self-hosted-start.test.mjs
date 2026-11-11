import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installationSecrets, migrationLockConnectionString, selfHostedEnvironment } from './self-hosted-start.mjs'

test('installation keys survive restart, remain private, and explicit overrides never enter the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-installation-'))
  try {
    const first = {}, concurrent = {}
    await Promise.all([installationSecrets(directory, first), installationSecrets(directory, concurrent)])
    assert.deepEqual(first, concurrent)
    assert.equal(Object.keys(first).length, 5)
    for (const key of Object.values(first)) assert.equal(Buffer.from(key, 'base64').length, 32)
    assert.equal((await stat(join(directory, 'installation-secrets.json'))).mode & 0o777, 0o600)
    const next = { BETTER_AUTH_SECRET: 'explicit-test-value-that-must-not-be-persisted' }
    await installationSecrets(directory, next)
    assert.equal(next.WORKSPACE_SECRETS_KEY, first.WORKSPACE_SECRETS_KEY)
    assert.equal(next.BETTER_AUTH_SECRET, 'explicit-test-value-that-must-not-be-persisted')
    assert.doesNotMatch(await readFile(join(directory, 'installation-secrets.json'), 'utf8'), /explicit-test-value/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('standalone startup uses the operator database and durable local Workflow only', () => {
  const env = selfHostedEnvironment({ DATABASE_URL: 'postgres://local:fixture@postgres/mikka', BETTER_AUTH_URL: 'https://self.example.test', MIKKA_DATA_DIR: '/data' }, '/app')
  assert.equal(env.MIKKA_DATABASE_URL, env.DATABASE_URL)
  assert.equal(env.WORKFLOW_TARGET_WORLD, 'local')
  assert.equal(env.WORKFLOW_LOCAL_DATA_DIR, '/data/workflow')
  assert.equal(env.WORKFLOW_LOCAL_BASE_URL, 'https://self.example.test')
  const override = 'http://127.0.0.1:4321/operator-routing'
  assert.equal(selfHostedEnvironment({ DATABASE_URL: env.DATABASE_URL, WORKFLOW_LOCAL_BASE_URL: override }, '/app').WORKFLOW_LOCAL_BASE_URL, override)
  assert.throws(() => selfHostedEnvironment({}, '/app'), /SELF_HOSTED_DATABASE_REQUIRED/)
  assert.throws(() => selfHostedEnvironment({ DATABASE_URL: 'postgres://fixture', VERCEL: '1' }, '/app'), /SELF_HOSTED_PLATFORM_ENV_REFUSED/)
  assert.throws(() => selfHostedEnvironment({ DATABASE_URL: 'postgres://fixture', WORKFLOW_TARGET_WORLD: 'vercel' }, '/app'), /SELF_HOSTED_LOCAL_WORKFLOW_REQUIRED/)
})

test('bad self-hosted origins fail before migration or sign-in', () => {
  const env = { DATABASE_URL: 'postgres://fixture', BETTER_AUTH_URL: 'https://self.example.test' }
  assert.equal(selfHostedEnvironment({ ...env, BETTER_AUTH_URL: 'https://self.example.test/' }, '/app').BETTER_AUTH_URL, 'https://self.example.test')
  for (const BETTER_AUTH_URL of ['not-a-url', 'http://self.example.test', 'https://self.example.test/mikka',
    'https://user:password@self.example.test', 'https://self.example.test?next=x', 'https://*.example.test']) {
    assert.throws(() => selfHostedEnvironment({ ...env, BETTER_AUTH_URL }, '/app'), /SELF_HOSTED_ORIGIN_INVALID/)
  }
})

test('published runtime, deployment and build sources cannot restore the retired workspace switch', () => {
  // Two upgrade regression tests must still pass an obsolete setting to prove it is ignored.
  const allowed = ['apps/api/runtime/server-page.test.ts', 'lib/server-info.test.ts']
  const flag = ['MIKKA', 'COMMUNITY', 'UI'].join('_')
  const scan = spawnSync('git', ['grep', '--fixed-strings', '--files-with-matches', '-I', '-e', flag,
    '--', '.', ':(exclude,glob)**/*.md', ':(exclude,glob)*.md', ...allowed.map(file => ':(exclude)' + file)],
  { cwd: new URL('../', import.meta.url), encoding: 'utf8' })
  if (scan.error) throw scan.error
  assert.equal(scan.status, 1, scan.stderr || 'Remove the retired workspace flag from: ' + scan.stdout.trim())
})

test('Neon migrations take an unpooled PostgreSQL session lock; queries remain pooled', () => {
  const endpoint = (host, user = 'fixture') => ['postgresql://', user, ':', 'synthetic', '@', host, '/mikka?sslmode=require'].join('')
  const pooled = endpoint('ep-sample-pooler.us-east-2.aws.neon.tech')
  const direct = endpoint('ep-sample.us-east-2.aws.neon.tech')
  const env = selfHostedEnvironment({ MIKKA_DATABASE_URL: pooled, MIKKA_DATABASE_URL_UNPOOLED: direct }, '/app')
  assert.equal(env.MIKKA_DATABASE_URL, pooled)
  assert.equal(migrationLockConnectionString(env), direct)
  // Backward compatibility for users who only configured one Neon URI.
  assert.equal(migrationLockConnectionString({ MIKKA_DATABASE_URL: pooled }), direct)
  assert.equal(migrationLockConnectionString({ MIKKA_DATABASE_URL: direct }), direct)
  // An explicitly provided direct endpoint wins over the pooled query URL.
  assert.equal(migrationLockConnectionString({ MIKKA_DATABASE_URL: pooled, MIKKA_DATABASE_URL_UNPOOLED: endpoint('db.example.invalid', 'custom') }), endpoint('db.example.invalid', 'custom'))
  assert.equal(migrationLockConnectionString({ MIKKA_DATABASE_URL: ['postgres://', 'mikka', ':', 'fixture', '@postgres:5432/mikka'].join('') }), ['postgres://', 'mikka', ':', 'fixture', '@postgres:5432/mikka'].join(''))
})
