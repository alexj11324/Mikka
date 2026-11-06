import test from 'node:test'
import assert from 'node:assert/strict'
import { BundledAuth } from './bundled-auth'
import { publicSession, type SessionVault, type StoredSession } from './session-vault'

const identity = publicSession({
  user: { id: '84c182d1-661c-461b-bca2-10410cb646d4', name: 'Startup Test', email: 'startup@example.invalid', image: null },
  session: { id: 'startup-public-session' },
})!
const account: StoredSession = { identity, token: 'startup-main-only-bearer' }
const body = JSON.stringify({ version: 1, action: 'desktop.bootstrap', args: [] })
const names = ['network.start', 'headers', 'cache.end', 'response.end']
const marks = (name: string) => performance.getEntriesByName('mikka.startup.main.bootstrap.' + name, 'mark')
const clear = () => names.forEach(name => performance.clearMarks('mikka.startup.main.bootstrap.' + name))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('startup diagnostics distinguish HTTP headers from awaited private persistence without releasing the response early', async t => {
  clear(); t.after(clear)
  const network = deferred<Response>()
  const fetching = deferred<void>()
  const saving = deferred<void>()
  const durable = deferred<void>()
  let fetches = 0
  let writes = 0
  const vault = {
    async loadAccounts() { return { activeUserId: account.identity.user.id, accounts: [structuredClone(account)] } },
    async saveAccounts() { writes++; saving.resolve(undefined); await durable.promise },
  } as unknown as SessionVault
  const auth = new BundledAuth({
    serverUrl: 'https://example.invalid/mikka', version: '1.0.0', vault,
    fetch: async () => {
      fetches++
      if (fetches === 1) { fetching.resolve(undefined); return network.promise }
      return Response.json({ version: 1, ok: true, result: identity })
    },
    openExternal: async () => {}, changed: () => {}, returned: () => {},
  })
  await auth.restore()
  let settled = false
  const result = auth.request('/api/desktop/rpc', { method: 'POST', body }).finally(() => { settled = true })
  await fetching.promise
  assert.equal(marks('network.start').length, 1)
  assert.equal(marks('headers').length, 0)
  network.resolve(Response.json({ version: 1, ok: true, result: identity },
    { headers: { 'x-mikka-session-cache': 'signed-cache-proof' } }))
  await saving.promise
  assert.equal(marks('headers').length, 1)
  assert.equal(marks('cache.end').length, 0)
  assert.equal(marks('response.end').length, 0)
  assert.equal(settled, false)
  durable.resolve(undefined)
  const response = await result
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { version: 1, ok: true, result: identity })
  assert.equal(writes, 1)
  const first = names.map(name => marks(name)[0]!.startTime)
  assert.ok(first.every((value, index) => index === 0 || value >= first[index - 1]!))
  await auth.request('/api/desktop/rpc', { method: 'POST', body })
  assert.deepEqual(names.map(name => marks(name).map(mark => mark.startTime)), first.map(value => [value]))
  assert.equal(writes, 1)
})

test('signed-out bootstrap creates no authenticated startup timing record', async t => {
  clear(); t.after(clear)
  const auth = new BundledAuth({
    serverUrl: 'https://example.invalid/mikka', version: '1.0.0',
    vault: { loadAccounts: async () => null } as unknown as SessionVault,
    fetch: async () => Response.json({ error: 'unauthenticated' }, { status: 401 }),
    openExternal: async () => {}, changed: () => {}, returned: () => {},
  })
  assert.equal((await auth.request('/api/desktop/rpc', { method: 'POST', body })).status, 401)
  assert.ok(names.every(name => marks(name).length === 0))
})
