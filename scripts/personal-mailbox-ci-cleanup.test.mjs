import assert from 'node:assert/strict'
import test from 'node:test'
import { revokeSyntheticMailboxCredentials } from './personal-mailbox-ci-cleanup.mjs'
const identity = { runId: 'nonce-run', owner: 'nonce-owner', deviceTokenId: 'nonce-device-token' }
test('CI cleanup attempts both exact nonce credentials and reports either failure without driver secrets', async () => {
  for (const failure of ['run_tokens', 'device_tokens', 'both', 'none']) {
    const calls = []
    const pool = { query(sql, args) {
      calls.push({ sql, args })
      if (failure === 'both' || sql.includes(failure)) throw Error('synthetic-driver-sensitive-detail')
      return { rowCount: 1 }
    } }
    const operation = revokeSyntheticMailboxCredentials(pool, identity)
    if (failure === 'none') assert.deepEqual(await operation, [1, 1])
    else await assert.rejects(operation, error => error.message === 'PERSONAL_MAILBOX_CI_CREDENTIAL_REVOKE_FAILED')
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map(call => call.args), [[identity.runId, identity.owner], [identity.deviceTokenId, identity.owner]])
    assert.ok(calls.every(call => call.sql.startsWith('update ') && call.sql.includes('"userId"=$2')))
  }
})
