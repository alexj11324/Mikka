import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundledAuth } from './bundled-auth'
import { BundledServers } from './bundled-servers'
import { ServerDirectory } from './server-directory'
import { SessionVault, storedSession, type EncryptedStorage, type StoredSession } from './session-vault'

const cloud = 'https://cloud.test/mikka'
const self = 'https://self.test/mikka'
const person = (id: string, server?: string): StoredSession => ({ token: `${id}-private-session-0123456789`, identity: { user: { id, email: `${id}@example.invalid`, name: id, image: null }, session: { id: `session-${id}` } }, ...(server ? { server } : {}) })
const discovery = { name: 'Acme Mikka', version: '2026.11.6', edition: 'community', basePath: '/mikka', desktopProtocol: { min: 0, max: 1 }, signIn: { google: false, github: false, email: true } }

function encryption(): EncryptedStorage {
  const key = randomBytes(32)
  return {
    available: async () => true,
    async encrypt(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]) },
    async decrypt(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') },
  }
}
async function folder(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mikka-servers-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  return root
}
type Call = { url: string; token: string | null; origin: string | null }
function setup(root: string, respond: (call: Call, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  let changed = 0
  const vault = new SessionVault(root, cloud, encryption())
  const directory = new ServerDirectory(join(root, 'servers.json'), cloud)
  const auth = new BundledAuth({ serverUrl: cloud, version: '0.1.2', vault, openExternal: async () => {}, returned: () => {}, changed: () => { changed++ },
    target: directory.target(), targetChanged: url => directory.follow(url),
    describe: url => ({ url, cloud: directory.isCloud(url), name: directory.info(url).name }),
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers)
      const call = { url, token: headers.get('authorization'), origin: headers.get('origin') }
      calls.push(call)
      return respond(call, init)
    } })
  const servers = new BundledServers(auth, directory, { appVersion: '0.1.2', enforceMinimum: false, fetch: async url => url === `${self}/api/desktop/discovery` ? Response.json(discovery) : new Response('no', { status: 404 }) })
  return { vault, directory, auth, servers, calls, changes: () => changed }
}

test('the vault keeps each account\'s exact server and refuses a widened or plain-HTTP one', () => {
  assert.equal(storedSession(person('a', self))?.server, self)
  assert.equal(storedSession(person('a'))?.server, undefined)
  for (const server of ['http://self.test/mikka', 'https://self.test/mikka/', 'https://self.test/mikka?x=1', 'https://*.test/mikka', 7]) assert.equal(storedSession({ ...person('a'), server }), null, String(server))
  assert.equal(storedSession({ ...person('a'), server: 'http://127.0.0.1:3100/mikka' })?.server, 'http://127.0.0.1:3100/mikka')
})

test('each account\'s bearer goes only to its own server; the switcher names servers once they differ', async t => {
  const root = await folder(t)
  const { vault, auth, calls } = setup(root, call => {
    if (call.url.endsWith('/api/workspace/switcher')) {
      const id = call.token?.includes('home') ? 'home' : 'away'
      return Response.json({ workspace: { id: '096db4ab-6bf3-4bcc-ad4b-dcfc521bb007' }, live: {}, accounts: [{ id, email: `${id}@example.invalid`, choices: [] }] })
    }
    return Response.json({})
  })
  await vault.saveAccounts({ activeUserId: 'home', accounts: [person('home'), person('away', self)] })
  await auth.restore()
  assert.equal(auth.serverUrl(), cloud)
  const response = await auth.request('/api/workspace/switcher')
  const body = await response.json() as { accounts: { id: string; server?: { url: string; cloud: boolean } }[] }
  assert.deepEqual(body.accounts.map(account => [account.id, account.server?.url, account.server?.cloud]), [['home', cloud, true], ['away', self, false]])
  for (const call of calls) {
    const expected = call.token?.includes('away') ? 'https://self.test' : 'https://cloud.test'
    assert.equal(new URL(call.url).origin, expected, call.url)
    assert.equal(call.origin, expected)
  }
  assert.deepEqual(new Set(calls.map(call => call.url)), new Set([`${cloud}/api/workspace/switcher`, `${self}/api/workspace/switcher`]))
})

test('switching to an account on another server moves the window and the sign-in target with it', async t => {
  const root = await folder(t)
  const { vault, auth, directory, calls } = setup(root, () => Response.json({ version: 1, ok: true, result: { ok: true } }))
  await vault.saveAccounts({ activeUserId: 'home', accounts: [person('home'), person('away', self)] })
  await auth.restore()
  const switched = await auth.request('/api/desktop/rpc', { method: 'POST', body: JSON.stringify({ version: 1, action: 'workspace.switchWorkspace', args: [{ accountId: 'away' }] }) })
  assert.equal(switched.status, 200)
  assert.equal(calls.at(-1)?.url, `${self}/api/desktop/rpc`)
  assert.equal(calls.at(-1)?.token, `Bearer ${person('away').token}`)
  assert.equal(auth.serverUrl(), self)
  assert.equal(directory.target(), self)
  await auth.request('/api/desktop/rpc', { method: 'POST', body: JSON.stringify({ version: 1, action: 'desktop.bootstrap', args: [] }) })
  assert.equal(calls.at(-1)?.url, `${self}/api/desktop/rpc`)
})

test('only a probed server can be chosen; signed out, requests and sign-in then go there', async t => {
  const root = await folder(t)
  const { auth, servers, calls, directory, changes } = setup(root, () => Response.json({ googleEnabled: false, githubEnabled: false, emailEnabled: true }))
  await auth.restore()
  await assert.rejects(servers.select(self), /desktop_server_not_probed/)
  assert.equal((await servers.probe('self.test')).status, 'ok')
  const state = await servers.select(self)
  assert.equal(state.target.url, self)
  assert.equal(state.current.name, 'Acme Mikka')
  assert.equal(changes(), 1)
  await auth.request('/api/desktop/config')
  assert.equal(calls.at(-1)?.url, `${self}/api/desktop/config`)
  assert.equal(calls.at(-1)?.token, null)
  await directory.saved()
  const saved = JSON.parse(await readFile(join(root, 'servers.json'), 'utf8'))
  assert.equal(saved.target, self)
  assert.equal(JSON.stringify(saved).includes('token'), false)
  assert.equal(new ServerDirectory(join(root, 'servers.json'), cloud).target(), self)
  assert.equal((await servers.select(null)).target.cloud, true)
})

test('an email sign-in on a self-hosted server stores that server with the account', async t => {
  const root = await folder(t)
  const token = 'self-hosted-private-session-0123456789'
  const { auth, servers, vault, calls } = setup(root, call => call.url.endsWith('/sign-in/email') ? Response.json({ token }) : Response.json(person('member').identity))
  await auth.restore()
  await servers.probe(self)
  await servers.select(self)
  assert.equal(await auth.signInEmail({ email: 'member@example.invalid', password: randomBytes(12).toString('hex') }), null)
  assert.equal((await vault.loadAccounts())?.accounts[0]?.server, self)
  assert.ok(calls.every(call => call.url.startsWith(`${self}/`)))
})

test('the same user id from a different server is refused, not merged', async t => {
  const root = await folder(t)
  const { auth, servers, vault } = setup(root, call => call.url.endsWith('/sign-in/email') ? Response.json({ token: 'collision-private-session-0123456789' }) : Response.json(person('home').identity))
  await vault.saveAccounts({ activeUserId: 'home', accounts: [person('home')] })
  await auth.restore()
  await servers.probe(self)
  await servers.select(self)
  await assert.rejects(auth.signInEmail({ email: 'home@example.invalid', password: randomBytes(12).toString('hex') }), /desktop_account_conflict/)
  assert.equal((await vault.loadAccounts())?.accounts[0]?.token, person('home').token)
})

test('disconnecting a server signs out only its accounts and moves to an account elsewhere', async t => {
  const root = await folder(t)
  const { vault, auth, servers, calls, directory } = setup(root, () => Response.json({ success: true }))
  await vault.saveAccounts({ activeUserId: 'away', accounts: [person('home'), person('away', self), person('other', self)] })
  await auth.restore()
  assert.equal(directory.target(), self)
  const state = await servers.disconnect(self)
  assert.deepEqual(calls.map(call => call.url), [`${self}/api/auth/sign-out`, `${self}/api/auth/sign-out`])
  assert.equal(auth.session()?.user.id, 'home')
  assert.equal(state.current.cloud, true)
  assert.deepEqual(state.servers.map(server => [server.url, server.accounts]), [[cloud, 1]])
  assert.deepEqual((await vault.loadAccounts())?.accounts.map(account => account.identity.user.id), ['home'])
  assert.equal(directory.target(), cloud)
})

test('a broken servers file falls back to the cloud', async t => {
  const root = await folder(t)
  await writeFile(join(root, 'servers.json'), '{"version":1,"target":"https://evil.test","servers":[]}')
  assert.equal(new ServerDirectory(join(root, 'servers.json'), cloud).target(), cloud)
  await writeFile(join(root, 'servers.json'), 'not json')
  assert.equal(new ServerDirectory(join(root, 'servers.json'), cloud).target(), cloud)
})
