import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionVault, storedAccounts, type StoredSession, type EncryptedStorage } from './session-vault'

const server = 'https://server.test/mikka'
const account = (id: string): StoredSession => ({ token: `${id}-${'private-'.repeat(5)}`, identity: { user: { id, email: `${id}@example.invalid`, name: `Fixture ${id}`, image: null }, session: { id: `session-${id}` } } })
function encryption(): EncryptedStorage {
  const key = randomBytes(32)
  return {
    available: async () => true,
    async encrypt(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]) },
    async decrypt(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') },
  }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-vault-accounts-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const crypto = encryption(), path = join(directory, 'desktop-session.bin')
  return { directory, path, crypto, vault: new SessionVault(directory, server, crypto) }
}

test('five accounts and their workspace selections round-trip only as encrypted data', async t => {
  const { vault, path } = await fixture(t)
  const accounts = ['a', 'b', 'c', 'd', 'e'].map(account)
  accounts[1]!.workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const value = { activeUserId: 'b', accounts }
  await vault.saveAccounts(value)
  assert.deepEqual(await vault.loadAccounts(), value)
  assert.deepEqual(await vault.load(), accounts[1])
  const ciphertext = await readFile(path)
  for (const entry of accounts) {
    assert.equal(ciphertext.includes(entry.token), false)
    assert.equal(ciphertext.includes(entry.identity.user.email), false)
  }
  assert.equal((await stat(path)).mode & 0o777, 0o600)
})

test('v1 ciphertext migrates atomically to one active v2 account and retains its selector', async t => {
  const { vault, path, crypto } = await fixture(t)
  const value = { ...account('legacy'), workspace: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
  await writeFile(path, await crypto.encrypt(JSON.stringify({ version: 1, server, value })), { mode: 0o600 })
  const expected = { activeUserId: 'legacy', accounts: [value] }
  assert.deepEqual(await vault.loadAccounts(), expected)
  assert.deepEqual(JSON.parse(await crypto.decrypt(await readFile(path))), { version: 2, server, value: expected })
  assert.deepEqual(await vault.load(), value)
})

test('duplicate owners, an unknown active owner, excess accounts and malformed secrets fail closed', async t => {
  const { vault, path, crypto } = await fixture(t)
  const invalid = [
    { activeUserId: 'a', accounts: [account('a'), account('a')] },
    { activeUserId: 'other', accounts: [account('a')] },
    { activeUserId: 'a', accounts: ['a', 'b', 'c', 'd', 'e', 'f'].map(account) },
    { activeUserId: 'a', accounts: [{ ...account('a'), token: 'bad\nheader' }] },
    { activeUserId: 'a', accounts: [] },
    { activeUserId: '', accounts: [] },
  ]
  for (const value of invalid) {
    assert.equal(storedAccounts(value), null)
    await assert.rejects(vault.saveAccounts(value), /Invalid desktop accounts/)
    await writeFile(path, await crypto.encrypt(JSON.stringify({ version: 2, server, value })))
    assert.equal(await vault.loadAccounts(), null)
  }
})

test('queued writes snapshot their accounts and preserve the last explicit active selection', async t => {
  const { vault } = await fixture(t)
  const a = account('a'), b = account('b')
  const first = { activeUserId: 'a', accounts: [a, b] }
  const saved = vault.saveAccounts(first)
  a.identity.user.email = 'mutated-after-save@example.invalid'
  first.accounts.length = 0
  await saved
  assert.equal((await vault.loadAccounts())?.accounts[0]?.identity.user.email, 'a@example.invalid')
  await Promise.all([
    vault.saveAccounts({ activeUserId: 'a', accounts: [account('a'), b] }),
    vault.saveAccounts({ activeUserId: 'b', accounts: [account('a'), b] }),
  ])
  assert.deepEqual(await vault.load(), b)
})

test('wrong origins, a locked keychain, malformed ciphertext and logout expose no retained account', async t => {
  const { vault, directory, path, crypto } = await fixture(t)
  await vault.saveAccounts({ activeUserId: 'a', accounts: [account('a'), account('b')] })
  assert.equal(await new SessionVault(directory, 'https://other.test/mikka', crypto).loadAccounts(), null)
  const locked = new SessionVault(directory, server, { ...crypto, available: async () => false })
  assert.equal(await locked.loadAccounts(), null)
  await assert.rejects(locked.saveAccounts({ activeUserId: 'a', accounts: [account('a')] }), /Secure session storage unavailable/)
  await writeFile(path, 'corrupt')
  assert.equal(await vault.loadAccounts(), null)
  await vault.save(account('legacy-api'))
  assert.deepEqual(await vault.load(), account('legacy-api'))
  await vault.save(null)
  assert.equal(await vault.loadAccounts(), null)
})
