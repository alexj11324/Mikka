import assert from 'node:assert/strict'
import test from 'node:test'
import { directDatabaseURL, directPoolOptions, sessionDatabaseURL } from './postgres-connection.mjs'

test('direct Neon sessions preserve identity and TLS, changing only the endpoint host', () => {
  const source = 'postgresql://ep-fixture-pooler.c-1.us-east-2.aws.neon.tech:5432/app?sslmode=verify-full&channel_binding=require&options=-c%20search_path%3Dfixture'
  const expected = source.replace('ep-fixture-pooler.', 'ep-fixture.')
  assert.equal(directDatabaseURL(source), expected)
  const ssl = { rejectUnauthorized: true, ca: 'synthetic-ca' }
  const options = directPoolOptions({ connectionString: source, ssl, max: 1 })
  assert.equal(options.connectionString, expected)
  assert.equal(options.ssl, ssl)
  assert.equal(directDatabaseURL(expected), expected)
  const local = 'postgres://127.0.0.1:55432/fixture_e2e?options=-c%20search_path%3Dfixture'
  assert.equal(directDatabaseURL(local), local)
  assert.equal(directPoolOptions({ host: '127.0.0.1', port: 55432 }).host, '127.0.0.1')
  assert.equal(directPoolOptions({ host: 'ep-fixture-pooler.c-1.aws.neon.tech' }).host, 'ep-fixture.c-1.aws.neon.tech')
})

test('host/identity overrides cannot silently send a direct-session operation to another target', () => {
  const source = 'postgres://ep-fixture-pooler.c-1.aws.neon.tech/app'
  for (const key of ['host', 'HOST', 'hostaddr', 'hostname', 'port', 'database', 'dbname', 'user', 'password', 'connectionString'])
    assert.throws(() => directDatabaseURL(source+'?'+key+'=different'), /NEON_CONNECTION_OVERRIDE_REFUSED/)
  assert.throws(() => directPoolOptions({ connectionString: source, host: 'elsewhere.example' }), /DATABASE_CONNECTION_HOST_CONFLICT/)
  assert.throws(() => directDatabaseURL('postgres://other.neon.tech/app'), /NEON_ENDPOINT_HOST_INVALID/)
  assert.throws(() => directDatabaseURL('invalid-private-url'), /^Error: DATABASE_CONNECTION_URL_INVALID$/)
})

test('a self-hosted explicit direct endpoint applies only to its original database', () => {
  const pooled = 'postgresql://queries.example.test/app'
  const direct = 'postgresql://session.example.test/app'
  const workspace = 'postgresql://queries.example.test/other'
  const env = { MIKKA_DATABASE_URL: pooled, MIKKA_DATABASE_URL_UNPOOLED: direct }
  assert.equal(sessionDatabaseURL(pooled, env), direct)
  assert.equal(sessionDatabaseURL(workspace, env), workspace)
  assert.equal(sessionDatabaseURL(pooled, { ...env, VERCEL_ENV: 'preview' }), pooled)
  assert.equal(sessionDatabaseURL(pooled, { ...env, VERCEL: '1' }), pooled)
  assert.equal(sessionDatabaseURL(undefined, env), undefined)
})
