import assert from 'node:assert/strict'
import test from 'node:test'
import { APPLICATION_SOURCE, classifyDatabaseURL, databaseConnectionMetadata } from './db-connection-metadata.mjs'

const base = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/acceptance/proactive-1157-1163',
  GITHUB_EVENT_NAME: 'push', DB_METADATA_SOURCE_SHA: APPLICATION_SOURCE, DB_METADATA_SECRET_READ: 'success' }
test('Neon pooled and direct URL markers produce booleans without credential or endpoint data', () => {
  for (const [suffix, expected] of [['-pooler', true], ['', false]]) {
    const value = `postgresql://synthetic_user:synthetic_password@ep-synthetic${suffix}.us-east-2.aws.neon.tech/synthetic_database?sslmode=require`
    const result = databaseConnectionMetadata({ env: { ...base, MIKKA_DATABASE_URL: value }, verifySource: () => APPLICATION_SOURCE })
    assert.equal(result.connection.isPooler, expected)
    assert.equal(result.databaseConnectionAttempted, false); assert.equal(result.sqlExecuted, false)
    assert.doesNotMatch(JSON.stringify(result), /synthetic_user|synthetic_password|ep-synthetic|synthetic_database|postgresql:\/\//)
  }
})
test('unavailable, malformed and non-Neon values remain unknown rather than reporting direct', () => {
  for (const value of [undefined, '', 'not-a-url', 'https://ep-synthetic-pooler.aws.neon.tech/db', 'postgres://u:p@database.invalid/db'])
    assert.equal(classifyDatabaseURL(value).isPooler, null)
  const result = databaseConnectionMetadata({ env: { ...base, DB_METADATA_SECRET_READ: 'failure' }, verifySource: () => APPLICATION_SOURCE })
  assert.equal(result.status, 'unavailable'); assert.equal(result.missingDoesNotProveProductionAbsence, true)
})
test('repository, event, branch and source guards reject before the named secret is inspected', () => {
  for (const override of [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_REPOSITORY: 'foreign/project' }, { DB_METADATA_SOURCE_SHA: 'a'.repeat(40) }]) {
    const env = { ...base, ...override }
    Object.defineProperty(env, 'MIKKA_DATABASE_URL', { get() { assert.fail('must not inspect the secret') } })
    assert.throws(() => databaseConnectionMetadata({ env, verifySource: () => APPLICATION_SOURCE }), /metadata_/)
  }
})
