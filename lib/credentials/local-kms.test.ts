import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { localKms, open, seal, sealSession } from './kms'

test('local envelope keys bind owner, credential, origin and payload purpose', async () => {
  const env = { CREDENTIAL_MASTER_KEY: randomBytes(32).toString('base64') }
  const app = localKms('app', env), broker = localKms('broker', env)
  const context = { userId: 'owner', credentialId: 'credential', origin: 'https://login.example.test' }
  const secret = Buffer.from('synthetic-password')
  const envelope = await seal(app, context, secret)
  assert.ok(secret.every(byte => byte === 0))
  assert.equal(envelope.wrappedDek.startsWith('local:v1:'), true)
  const opened = await open(broker, context, envelope)
  assert.equal(opened.toString(), 'synthetic-password'); opened.fill(0)
  for (const other of [{ ...context, userId: 'other' }, { ...context, credentialId: 'other' }, { ...context, origin: 'https://other.test' }]) {
    await assert.rejects(open(broker, other, envelope), { code: 'credential_unavailable' })
  }
  const tampered = { ...envelope, wrappedDek: envelope.wrappedDek.slice(0, -5) + 'AAAAA' }
  await assert.rejects(open(broker, context, tampered))
  await assert.rejects(open(localKms('broker', { CREDENTIAL_MASTER_KEY: randomBytes(32).toString('base64') }), context, envelope))
  await assert.rejects(open(broker, context, envelope, 'session'))
  const session = await sealSession(broker, context, envelope.wrappedDek, Buffer.from('{"cookies":[]}'))
  const snapshot = await open(broker, context, session, 'session')
  assert.equal(snapshot.toString(), '{"cookies":[]}'); snapshot.fill(0)
  await assert.rejects(open(app, context, envelope))
  await assert.rejects(broker.generate(context))
})

test('missing and noncanonical local master keys fail without provider access', async () => {
  for (const key of ['', 'not-base64', randomBytes(16).toString('base64'), randomBytes(32).toString('base64') + '\n']) {
    await assert.rejects(localKms('app', { CREDENTIAL_MASTER_KEY: key }).generate({ userId: 'u', credentialId: 'c', origin: 'https://example.test' }))
  }
})
