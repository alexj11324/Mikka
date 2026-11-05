import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { nativeKeychainLog, probeCryptoInMain } from './native-crypto.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-native-crypto-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const profiles = ['profile-a', 'profile-b'].map(name => join(directory, name))
  await Promise.all(profiles.map(profile => mkdir(profile, { mode: 0o700 })))
  const key = randomBytes(32)
  const plaintexts = []
  const safeStorage = {
    async isAsyncEncryptionAvailable() { assert.equal(this, safeStorage); return true },
    // This injected cipher tests the harness, not the operating-system store.
    async encryptStringAsync(value) {
      assert.equal(this, safeStorage)
      plaintexts.push(value)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    async decryptStringAsync(value) {
      assert.equal(this, safeStorage)
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return { result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') }
    },
  }
  const app = profile => ({
    isPackaged: true, whenReady: async () => {}, getName: () => 'Mikka Dev', getPath: () => profile,
    commandLine: { hasSwitch: () => false, getSwitchValue: () => '' },
  })
  const input = (index, phase) => ({ profile: profiles[index], canary: join(directory, 'canary.json'), phase })
  return { profiles, safeStorage, app, input, plaintexts }
}

test('three fresh main instances verify both prior canaries across profile and mode changes', async t => {
  const value = await fixture(t)
  const reports = []
  for (const [profile, phase, verified] of [[0, 'create', 0], [1, 'continue', 1], [1, 'verify', 2]]) {
    const report = await probeCryptoInMain({ app: value.app(value.profiles[profile]), safeStorage: value.safeStorage }, value.input(profile, phase))
    reports.push(report)
    assert.equal(report.passed, true)
    assert.equal(report.verifiedCanaries, verified)
    assert.equal(report.encrypted && report.decrypted, true)
  }
  const evidence = JSON.stringify(reports)
  assert.equal(value.plaintexts.some(plaintext => evidence.includes(plaintext)), false)
  assert.equal(evidence.includes(value.profiles[0]), false)
  assert.equal(evidence.includes('ciphertext'), false)
})

test('availability alone cannot pass an actual encryption failure or write a canary', async t => {
  const value = await fixture(t)
  value.safeStorage.encryptStringAsync = async () => { throw new Error('PRIVATE native message /keychain/item') }
  const report = await probeCryptoInMain({ app: value.app(value.profiles[0]), safeStorage: value.safeStorage }, value.input(0, 'create'))
  assert.equal(report.available, true)
  assert.equal(report.passed, false)
  assert.deepEqual(report.failure, { stage: 'encrypt', kind: 'Error', code: 'other' })
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false)
  await assert.rejects(access(value.input(0, 'create').canary), { code: 'ENOENT' })
})

test('unavailable OS encryption and wrong profile fail before encryption', async t => {
  const value = await fixture(t)
  let calls = 0
  value.safeStorage.encryptStringAsync = async () => { calls += 1; throw new Error('must not run') }
  value.safeStorage.isAsyncEncryptionAvailable = async () => false
  const unavailable = await probeCryptoInMain({ app: value.app(value.profiles[0]), safeStorage: value.safeStorage }, value.input(0, 'create'))
  assert.equal(unavailable.failure.stage, 'availability')
  const wrong = await probeCryptoInMain({ app: value.app(value.profiles[1]), safeStorage: value.safeStorage }, value.input(0, 'create'))
  assert.equal(wrong.failure.stage, 'identity')
  assert.equal(calls, 0)
})

test('second instance must genuinely decrypt the prior process canary, not only create a new one', async t => {
  const value = await fixture(t)
  const first = await probeCryptoInMain({ app: value.app(value.profiles[0]), safeStorage: value.safeStorage }, value.input(0, 'create'))
  assert.equal(first.passed, true)
  value.safeStorage.decryptStringAsync = async () => ({ result: 'different' })
  const second = await probeCryptoInMain({ app: value.app(value.profiles[1]), safeStorage: value.safeStorage }, value.input(1, 'continue'))
  assert.equal(second.passed, false)
  assert.equal(second.failure.stage, 'prior-decrypt')
  assert.equal(second.encrypted, false)
  assert.equal(second.verifiedCanaries, 0)
})

test('canary reads cannot follow a substituted symlink outside the owned artifact', async t => {
  const value = await fixture(t)
  await symlink('/outside-owned-test/nonexistent', value.input(0, 'create').canary)
  const report = await probeCryptoInMain({ app: value.app(value.profiles[1]), safeStorage: value.safeStorage }, value.input(1, 'continue'))
  assert.equal(report.passed, false)
  assert.equal(report.failure.stage, 'canary-read')
  assert.equal(report.encrypted, false)
})

test('native Keychain diagnostics retain only closed status codes across split chunks', () => {
  const log = nativeKeychainLog()
  log.push('unknown PRIVATE line\nKeychain lookup fai')
  log.push('led: PRIVATE path (OSStatus -25293)\nKeychain lookup failed: other -12345\n')
  assert.deepEqual(log.snapshot(), { lookupFailureCount: 2, knownStatusCodes: [-25293], truncated: false })
  log.push('x'.repeat(20_000))
  assert.equal(log.snapshot().truncated, true)
  assert.equal(JSON.stringify(log.snapshot()).includes('PRIVATE'), false)
})
