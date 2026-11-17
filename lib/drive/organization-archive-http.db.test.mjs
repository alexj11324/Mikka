import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID, webcrypto } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { serve } from 'srvx/node'
import { apiAliases } from '../../apps/api/compat-aliases.mjs'
import { BundledAuth } from '../../apps/desktop/src/main/bundled-auth.ts'
import { bundledProtocol } from '../../apps/desktop/src/main/bundled-protocol.ts'
import { SessionVault } from '../../apps/desktop/src/main/session-vault.ts'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { bootstrapEnvironment } from '../../scripts/test-accounts/bootstrap.mjs'
import { assertDeploymentIdentity } from '../../scripts/test-accounts/environment.mjs'
import { TestAccountPool } from '../../scripts/test-accounts/pool.mjs'
import { disposableDatabase, E2E_DB_RULE } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database.ts'

const databaseUrl = process.env.E2E_DATABASE_URL
if (databaseUrl) assert.ok(disposableDatabase(process.env, databaseUrl), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail(E2E_DB_RULE)

async function nativeAccount({ origin, directory, role, cookie, userId, clients }) {
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const encryption = {
    available: async () => true,
    async encrypt(value) {
      const iv = randomBytes(12)
      const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(value))
      return Buffer.concat([iv, Buffer.from(encrypted)])
    },
    async decrypt(bytes) {
      const clear = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12))
      return Buffer.from(clear).toString('utf8')
    },
  }
  const completed = Promise.withResolvers()
  const serverUrl = origin + '/mikka'
  const auth = new BundledAuth({
    serverUrl, version: '1.0.0', vault: new SessionVault(join(directory, role), serverUrl, encryption),
    fetch: (url, init) => { assert.equal(new URL(url).origin, origin); return fetch(url, init) },
    changed() {}, returned: completed.resolve,
    async openExternal(location) {
      const login = new URL(location)
      assert.equal(login.origin, origin)
      const state = login.searchParams.get('desktop_state')
      const callback = new URL(login.searchParams.get('desktop_callback'))
      assert.equal(callback.hostname, '127.0.0.1')
      const query = new URLSearchParams({ state, callback: callback.href })
      const response = await fetch(serverUrl + '/api/desktop/return?' + query, { headers: { cookie }, redirect: 'manual' })
      assert.equal(response.status, 303)
      const destination = new URL(response.headers.get('location'))
      assert.equal(destination.origin + destination.pathname, callback.href)
      const returned = await fetch(destination, { redirect: 'manual' })
      assert.equal(returned.status, 200)
      await returned.body?.cancel()
    },
  })
  clients.push(auth)
  await auth.signIn({})
  const deadline = AbortSignal.timeout(15_000)
  await Promise.race([completed.promise, once(deadline, 'abort').then(() => { throw new Error('Desktop PKCE return timed out') })])
  const session = await auth.request('/api/auth/get-session')
  assert.equal(session.status, 200)
  assert.equal((await session.json()).user.id, userId)
  const protocol = bundledProtocol(directory, auth)
  return (path, init) => {
    const address = new URL(path, origin)
    return protocol(new Request('mikka://app/mikka' + address.pathname.replace(/^\/mikka(?=\/)/, '') + address.search, init))
  }
}

test('registered H3 Organization Files archive and unarchive return the catalog volume on retries for two leased Desktop identities', {
  skip: !databaseUrl, timeout: 150_000,
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  const name = 'drive_archive_' + randomUUID().replaceAll('-', '') + '_e2e'
  const url = new URL(databaseUrl)
  url.pathname = '/' + name
  const ownerMark = await createTestDatabase(admin, name, 'template0')
  const pool = new Pool({ connectionString: url.href, max: 4 })
  const directory = await mkdtemp(join(tmpdir(), 'mikka-drive-archive-'))
  const before = { ...process.env }
  const loader = registerHooks({ resolve(specifier, context, next) {
    const alias = specifier !== '@' && apiAliases[specifier]
    return next(alias ? pathToFileURL(alias).href : specifier, context)
  } })
  const clients = []
  let server, runtime, accounts, lease, appPool, workspacePool
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const descriptor = join(directory, 'environment.json')
    Object.assign(process.env, { E2E_DATABASE_URL: url.href, DATABASE_URL: url.href, MIKKA_DATABASE_URL: url.href,
      ORVILO_DATABASE_URL: url.href, NODE_ENV: 'test', MIKKA_EDITION: 'community', MIKKA_BASE_PATH: '/mikka',
      MIKKA_TEST_MODE: '1', MIKKA_LOCAL_TEST_ACCOUNTS: '1', MIKKA_TEST_DEPLOYMENT_SHA: revision,
      MIKKA_TEST_ENVIRONMENT_FILE: descriptor, BETTER_AUTH_SECRET: randomBytes(32).toString('hex') })
    const migrations = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(migrations)).filter(file => file.endsWith('.sql'))))
      await pool.query(await readFile(new URL(file, migrations), 'utf8'))
    let app
    runtime = serve({ manual: true, silent: true, gracefulShutdown: false, fetch: request => app.fetch(request) })
    server = createServer(runtime.node.handler)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = 'http://127.0.0.1:' + server.address().port
    Object.assign(process.env, { BETTER_AUTH_URL: origin, E2E_BASE_URL: origin, AUTH_TRUSTED_ORIGINS: origin })
    app = (await import('../../apps/api/src/index.ts')).default
    appPool = (await import('../db/index.ts')).pool
    workspacePool = (await import('../workspace-db.ts')).workspacePool
    const environment = await bootstrapEnvironment({ connectionString: url.href, origin, deploymentSha: revision,
      id: 'drive-archive-' + randomUUID(), outputFile: descriptor, authorizeDatabase: async db => {
        const { rows: [actual] } = await db.query(`SELECT datname, shobj_description(oid,'pg_database') AS marker,
          current_setting('server_version_num')::int AS version FROM pg_database WHERE datname=current_database()`)
        assert.equal(actual.datname, name)
        assert.equal(actual.marker, ownerMark)
        assert.equal(Math.floor(actual.version / 10000), 17)
      } })
    await assertDeploymentIdentity(environment)
    accounts = new TestAccountPool(pool, environment)
    await accounts.prepare({ pairs: 1 })
    lease = await accounts.acquire({ runId: 'drive-' + randomUUID(), workerId: 'archive', requestId: randomUUID(), ttlMs: 120_000 })
    const people = {}
    for (const slot of lease.accounts) {
      const email = 'drive-' + randomUUID() + '@example.test', credentialRef = randomUUID() + '.json'
      await accounts.reserveAccount(lease, { slotId: slot.slotId, email, credentialRef })
      const response = await fetch(origin + '/mikka/api/auth/sign-up/email', { method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: randomBytes(32).toString('hex'), name: 'Drive ' + slot.role }) })
      assert.equal(response.status, 200)
      const { user } = await response.json()
      const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      assert.ok(cookie)
      await accounts.bindAccount(lease, { slotId: slot.slotId, email, credentialRef, userId: user.id })
      const send = await nativeAccount({ origin, directory, role: slot.role, cookie, userId: user.id, clients })
      await accounts.sealAccount(lease, slot.slotId)
      people[slot.role] = { id: user.id, send }
    }
    const { owner, peer } = people
    assert.notEqual(owner.id, peer.id)
    const { seedWorkspace } = await import('../../tests/support/workspace-admin-db.ts')
    const workspace = await seedWorkspace(pool, owner.id, [{ userId: owner.id, role: 'admin' }, { userId: peer.id, role: 'member' }])
    const org = randomUUID()
    await pool.query('INSERT INTO mikka_organizations(id,name,"createdBy") VALUES($1,$2,$3)', [org, 'Files', owner.id])
    await pool.query('INSERT INTO mikka_organization_workspaces("organizationId","workspaceId") VALUES($1,$2)', [org, workspace.id])
    for (const person of [owner, peer]) {
      await pool.query(`INSERT INTO mikka_organization_members("organizationId","userId",role,name,email)
        SELECT $1,id,$3,name,email FROM "user" WHERE id=$2`, [org, person.id, person === owner ? 'owner' : 'member'])
    }
    const created = await owner.send('/mikka/api/drive/volumes?workspaceId=' + workspace.id, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Archive fixture' }) })
    assert.equal(created.status, 201)
    const { volume } = await created.json()
    const { readOrganizationDriveVolumes, setOrganizationDriveArchived } = await import('./client.ts')
    const list = (archived) => readOrganizationDriveVolumes(org, { userId: owner.id, archived }, owner.send)
    const change = archived => setOrganizationDriveArchived(org, volume.id, archived, owner.send)
    const original = (await list(false)).find(row => row.id === volume.id)
    assert.ok(original)
    assert.equal(original.driveScope, 'user')
    assert.equal(original.workspaceId, workspace.id)
    const stored = async () => (await pool.query('SELECT "updatedAt", "headVersionId" FROM drive_volumes WHERE id=$1', [volume.id])).rows[0]
    await accounts.assertLease(lease)
    const archived = await change(true), afterArchive = await stored()
    assert.deepEqual(archived, { ...original, archived: true })
    assert.deepEqual(await change(true), archived)
    assert.deepEqual(await stored(), afterArchive)
    assert.deepEqual((await list(true)).find(row => row.id === volume.id), archived)
    assert.ok(!(await list(false)).some(row => row.id === volume.id))
    for (const action of ['archive', 'unarchive']) {
      const denied = await peer.send('/mikka/api/organizations/' + org + '/drive/' + volume.id + '/' + action, { method: 'POST' })
      assert.equal(denied.status, 404)
    }
    assert.deepEqual(await stored(), afterArchive)
    assert.deepEqual(await change(false), original)
    const afterRestore = await stored()
    assert.deepEqual(await change(false), original)
    assert.deepEqual(await stored(), afterRestore)
    assert.deepEqual((await list(false)).find(row => row.id === volume.id), original)
    await accounts.assertLease(lease)
  } finally {
    try {
      for (const client of clients) client.dispose()
      if (lease) assert.equal((await accounts.release(lease, { outcome: 'dirty' })).state, 'quarantined')
    } finally {
      server?.closeAllConnections()
      if (server?.listening) await new Promise(done => server.close(done))
      try { await runtime?.close() } finally {
        loader.deregister()
        for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]
        Object.assign(process.env, before)
        try { await dropTestDatabase(admin, name, pool, appPool, workspacePool) }
        finally { await admin.end(); await rm(directory, { recursive: true, force: true }) }
      }
    }
  }
})
