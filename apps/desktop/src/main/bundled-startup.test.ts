import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundledAuth } from './bundled-auth'
import { bundledProtocol } from './bundled-protocol'
import { SessionVault, type StoredAccounts } from './session-vault'

const retained: StoredAccounts = {
  activeUserId: 'owner', accounts: [{
    token: 'fixture-native-bearer-not-a-real-credential',
    workspace: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    identity: { user: { id: 'owner', name: 'Fixture', email: 'owner@example.invalid' }, session: { id: 'retained-session' } },
  }],
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function setup() {
  const loading = deferred<StoredAccounts | null>()
  const writes: (StoredAccounts | null)[] = []
  const requests: { path: string; headers: Headers }[] = []
  let available = 0, changed = 0, loads = 0
  class DelayedVault extends SessionVault {
    override async loadAccounts() { loads++; return loading.promise }
    override async saveAccounts(value: StoredAccounts | null) { writes.push(structuredClone(value)) }
    override async ensureAvailable() { available++ }
  }
  const vault = new DelayedVault('/unused-test-vault', 'https://server.test/mikka', {
    available: async () => true, encrypt: async value => Buffer.from(value), decrypt: async value => value.toString(),
  })
  const auth = new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '1.0.0', vault,
    async fetch(url, init) {
      const path = new URL(url).pathname
      requests.push({ path, headers: new Headers(init?.headers) })
      if (path.endsWith('/sign-in/email')) return Response.json({ code: 'INVALID_EMAIL_OR_PASSWORD' }, { status: 401 })
      if (path.endsWith('/list-accounts')) return Response.json([{ providerId: 'github' }])
      return Response.json({ ok: true })
    }, openExternal: async () => {}, returned: () => {}, changed: () => { changed++ },
  })
  return { auth, loading, requests, writes, state: () => ({ available, changed, loads }) }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

test('local assets load during vault restoration; authenticated transport waits and uses the restored identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-startup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'index.html'), '<main>local loading shell</main>')
  const { auth, loading, requests } = setup()
  t.after(() => auth.dispose())
  const restoring = auth.restore()
  const serve = bundledProtocol(root, auth)
  const request = serve(new Request('mikka://app/mikka/api/workspace'))
  assert.equal(await (await serve(new Request('mikka://app/mikka'))).text(), '<main>local loading shell</main>')
  await turn()
  assert.equal(requests.length, 0, 'no anonymous request or 401 is allowed while the retained credential is loading')
  loading.resolve(structuredClone(retained))
  await restoring
  assert.equal((await request).status, 200)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.headers.get('authorization'), `Bearer ${retained.accounts[0]!.token}`)
  assert.equal(requests[0]!.headers.get('cookie'), `mikka-workspace=${retained.accounts[0]!.workspace}`)
})

test('a sign-out during restore revokes and clears the retained account rather than resurrecting it', async () => {
  const { auth, loading, requests, writes, state } = setup()
  const restoring = auth.restore()
  const signingOut = auth.signOut()
  await turn()
  assert.equal(state().changed, 0)
  assert.equal(writes.length, 0)
  loading.resolve(structuredClone(retained))
  await Promise.all([restoring, signingOut])
  assert.equal(auth.session(), null)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.path, '/mikka/api/auth/sign-out')
  assert.equal(requests[0]!.headers.get('authorization'), `Bearer ${retained.accounts[0]!.token}`)
  assert.equal(writes.at(-1), null)
  auth.dispose()
})

test('email sign-in and account reads cannot overtake initial restore', async () => {
  const { auth, loading, requests, state } = setup()
  const restoring = auth.restore()
  const email = auth.signInEmail({ email: 'new@example.invalid', password: 'fixture-only' })
  let accountsFinished = false
  const accounts = auth.accounts().then(value => { accountsFinished = true; return value })
  await turn()
  assert.equal(state().available, 0)
  assert.equal(accountsFinished, false)
  assert.equal(requests.length, 0)
  loading.resolve(structuredClone(retained))
  await restoring
  assert.deepEqual(await accounts, [{ providerId: 'github' }])
  assert.deepEqual(await email, { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 })
  auth.dispose()
})

test('all waiters join one restore and an empty vault preserves ordinary signed-out behavior', async () => {
  const { auth, loading, requests, state } = setup()
  const restoring = auth.restore()
  assert.equal(auth.restore(), restoring)
  assert.equal(auth.whenRestored(), restoring)
  loading.resolve(null)
  await restoring
  assert.equal(state().loads, 1)
  assert.equal(auth.session(), null)
  await auth.request('/api/desktop/config', {}, false)
  assert.equal(requests[0]!.headers.get('authorization'), null)
  assert.deepEqual(await auth.accounts(), [])
  auth.dispose()
})
