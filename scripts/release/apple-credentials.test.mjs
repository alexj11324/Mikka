import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createPrivateKey } from 'node:crypto'
import { appleCredentialAliases, prepareAppleCredentials } from './apple-credentials.mjs'

const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const source = { ASC_API_KEY_P8: pem, ASC_API_KEY_ID: 'FIXTUREKEY', ASC_API_ISSUER_ID: '11111111-1111-4111-8111-111111111111' }
test('existing raw or base64 ASC key names map to the identical signing key without changing custody', () => {
  for (const value of [pem, Buffer.from(pem).toString('base64')]) {
    const out = appleCredentialAliases({ ...source, ASC_API_KEY_P8: value })
    assert.deepEqual(Object.keys(out).sort(), ['APPLE_API_ISSUER', 'APPLE_API_KEY_ID', 'APPLE_API_KEY_P8_BASE64'])
    assert.equal(createPrivateKey(Buffer.from(out.APPLE_API_KEY_P8_BASE64, 'base64')).export({ type: 'pkcs8', format: 'pem' }).toString(), pem)
  }
})
test('invalid key types and newline-bearing identifiers fail before runner environment writes', () => {
  assert.throws(() => appleCredentialAliases({ ...source, ASC_API_KEY_P8: 'invalid' }), /RELEASE_APPLE_KEY_INVALID/)
  assert.throws(() => appleCredentialAliases({ ...source, ASC_API_KEY_ID: 'FIXTURE\nOTHER=value' }), /RELEASE_APPLE_IDENTIFIERS_INVALID/)
  assert.throws(() => appleCredentialAliases(source, true), /RELEASE_APPLE_CERTIFICATE_MISSING/)
  assert.throws(() => prepareAppleCredentials({ ...source, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/feature' }), /RELEASE_APPLE_RUNNER_REQUIRED/)
})
test('desktop aliases preserve the existing certificate and refuse multiline environment injection', () => {
  const env = { ...source, APPLE_TEAM_ID: 'FIXTURETEAM', APPLE_DEVELOPER_ID_P12_BASE64: 'c3ludGhldGlj', APPLE_DEVELOPER_ID_P12_PASSWORD: 'synthetic-only' }
  const out = appleCredentialAliases(env, true)
  assert.equal(out.CSC_LINK, env.APPLE_DEVELOPER_ID_P12_BASE64)
  assert.equal(out.CSC_KEY_PASSWORD, env.APPLE_DEVELOPER_ID_P12_PASSWORD)
  assert.throws(() => appleCredentialAliases({ ...env, APPLE_DEVELOPER_ID_P12_PASSWORD: 'synthetic\nOTHER=value' }, true), /RELEASE_APPLE_ALIAS_INVALID/)
})
