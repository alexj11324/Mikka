import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { canonicalOrigin, assertSameOrigin, submitSchema, otpSchema, CredentialError, type EncryptionContext } from './contracts'
import { seal, open, sealSession, type Kms } from './kms'
import { checkCredentialRequest, credentialBody, credentialFailure } from './http'
import { Cdp } from './browser'
import { assertNoSecret, fingerprint } from './fingerprint'

function fixtureKms(): Kms {
  const keys = new Map<string, { key: Buffer; context: string }>()
  return {
    async generate(context) {
      const key = randomBytes(32), wrapped = randomBytes(32).toString('base64')
      keys.set(wrapped, { key: Buffer.from(key), context: JSON.stringify(context) })
      return { plaintext: key, wrapped }
    },
    async decrypt(wrapped, context) {
      const record = keys.get(wrapped)
      if (!record || JSON.stringify(context) !== record.context) throw new CredentialError()
      return Buffer.from(record.key)
    },
  }
}
const owner: EncryptionContext = { userId: 'owner-a', credentialId: 'opaque-random-id', origin: 'https://example.com' }
test('AES-GCM and KMS context isolate owner, credential id, and origin', async () => {
  const kms = fixtureKms(), plaintext = Buffer.from('test-password-never-log')
  const envelope = await seal(kms, owner, plaintext)
  assert(plaintext.every(byte => byte === 0))
  assert.equal((await open(kms, owner, envelope)).toString(), 'test-password-never-log')
  for (const alternate of [{ ...owner, userId: 'owner-b' }, { ...owner, credentialId: 'forged' }, { ...owner, origin: 'https://evil.example' }]) await assert.rejects(open(kms, alternate, envelope))
  await assert.rejects(open(kms, owner, { ...envelope, ciphertext: Buffer.from('tampered').toString('base64') }))
  await assert.rejects(open(kms, owner, { ...envelope, nonce: randomBytes(12).toString('base64') }))
})
test('session ciphertext has distinct AAD and fresh nonce', async () => {
  const kms = fixtureKms(), password = await seal(kms, owner, Buffer.from('password'))
  const session = await sealSession(kms, owner, password.wrappedDek, Buffer.from('cookie-state'))
  assert.notEqual(password.nonce, session.nonce)
  assert.equal((await open(kms, owner, session, 'session')).toString(), 'cookie-state')
  await assert.rejects(open(kms, owner, session))
  await assert.rejects(open(kms, owner, password, 'session'))
})
test('provider failure still clears the plaintext buffer and never returns cause', async () => {
  const buffer = Buffer.from('test-secret')
  await assert.rejects(seal({ ...fixtureKms(), generate: async () => { throw new CredentialError() } }, owner, buffer))
  assert(buffer.every(byte => byte === 0))
  const failure = credentialFailure(new Error('test-secret'))
  assert.equal(failure.status, 503)
  assert.equal((await failure.text()).includes('test-secret'), false)
})
test('exact HTTPS origin rejects userinfo and IDNA confusables without restricting browsing', () => {
  assert.equal(canonicalOrigin('https://EXAMPLE.com/login'), 'https://example.com')
  assertSameOrigin('https://example.com:443/login', 'https://example.com')
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com.', 'javascript:alert(1)']) assert.throws(() => canonicalOrigin(url))
  for (const url of ['https://example.com.evil.test', 'https://ｅxamplе.com', 'https://example.com:444', 'https://sub.example.com']) assert.throws(() => assertSameOrigin(url, 'https://example.com'))
})
test('submission schema rejects caller-specified user/id, CR LF NUL and excess fields', () => {
  const input = { nonce: 'a'.repeat(43), origin: owner.origin, username: 'test', password: 'test-password' }
  assert(submitSchema.safeParse(input).success)
  for (const additional of [{ userId: 'b' }, { credentialId: 'forged' }, { lease: 'replay' }]) assert(!submitSchema.safeParse({ ...input, ...additional }).success)
  for (const password of ['a\rb', 'a\nb', 'a\0b']) assert(!submitSchema.safeParse({ ...input, password }).success)
})
test('CSRF requires exact origin, dedicated header and non-cross-site metadata', () => {
  const request = (headers: Record<string, string>) => new Request('https://app.example/api/credentials', { method: 'POST', headers })
  checkCredentialRequest(request({ origin: 'https://app.example', 'x-mikka-credential': '1' }))
  const rejected: Record<string, string>[] = [{ origin: 'https://evil.example', 'x-mikka-credential': '1' }, { origin: 'https://app.example' }, { origin: 'https://app.example', 'x-mikka-credential': '1', 'sec-fetch-site': 'cross-site' }]
  for (const headers of rejected) assert.throws(() => checkCredentialRequest(request(headers)))
})
test('actual streaming payload limit applies without content-length', async () => {
  await assert.rejects(credentialBody(new Request('https://app.example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(13000) }) })), (error: unknown) => error instanceof CredentialError && error.status === 413)
  assert.deepEqual(await credentialBody(new Request('https://app.example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ok":true}' })), { ok: true })
})
test('pushState/hash changes cannot resume screenshots while fields remain populated', async () => {
  const cdp = Object.create(Cdp.prototype) as Cdp
  cdp.call = async () => ({ frameTree: { frame: { url: 'https://example.com/changed#hash' } } })
  cdp.evaluate = async () => false
  assert.equal(await cdp.safeToResume('https://example.com/login'), false)
  cdp.evaluate = async () => true
  assert.equal(await cdp.safeToResume('https://example.com/login'), true)
})

test('HMAC scanner rejects nested chat/tool secret copies without retaining values', () => {
  const key = 'unit-test-auth-secret', entry = fingerprint('a', 'test-password', key)
  assert(!JSON.stringify(entry).includes('test-password'))
  assert.throws(() => assertNoSecret('a', { content: [{ text: 'prefix test-password suffix' }] }, [entry], key), CredentialError)
  assertNoSecret('a', { text: 'safe status' }, [entry], key)
  assertNoSecret('b', { text: 'test-password' }, [entry], key)
})

test('verification codes use a separate authenticated envelope purpose', async () => {
  const kms = fixtureKms(), code = await seal(kms, owner, Buffer.from('123456'), 'otp')
  assert.equal((await open(kms, owner, code, 'otp')).toString(), '123456')
  await assert.rejects(open(kms, owner, code))
  assert(otpSchema.safeParse({ nonce: 'a'.repeat(43), origin: owner.origin, code: '123456' }).success)
  assert(!otpSchema.safeParse({ nonce: 'a'.repeat(43), origin: owner.origin, code: '123456', credentialId: 'forged' }).success)
})
