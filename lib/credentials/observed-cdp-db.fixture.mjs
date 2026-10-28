import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { Cdp } from './browser.ts'
import { fillCredential } from './broker.ts'
import { CredentialStore } from './store.ts'
async function retainedFixture() {

const databaseURL = process.env.CREDENTIAL_TEST_DATABASE_URL
if (!databaseURL || new URL(databaseURL).pathname !== '/credential_test') throw Error('Use an isolated credential_test database')
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex')
const dir = mkdtempSync(join(tmpdir(), 'mikka-broker-db-cdp-')), cert = join(dir, 'cert.pem'), keyPath = join(dir, 'key.pem')
if (spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' }).status !== 0) throw Error('fixture certificate failed')
const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(cert) }, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<input id="fixture" type="password">') })
const schema = `credential_${randomBytes(8).toString('hex')}`, admin = new Pool({ connectionString: databaseURL })
let pool, chrome, setup, verify
try {
  await admin.query(`CREATE SCHEMA ${schema}`)
  pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY); CREATE TABLE bots(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid); CREATE TABLE bot_subagents(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,"botId" uuid,status text,"targetId" text,epoch integer); CREATE TABLE agent_runs(id uuid,"userId" text,"botId" uuid,"stopRequestedAt" timestamptz,status text,"leaseExpiresAt" timestamptz); CREATE TABLE workspace_computer_policies("workspaceId" uuid PRIMARY KEY, permission text NOT NULL, version integer NOT NULL)`)
  await pool.query(readFileSync(new URL('../../drizzle/20261028174823_account_credential_vault.sql', import.meta.url), 'utf8'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--ignore-certificate-errors', `--user-data-dir=${dir}/profile`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' })
  console.log(JSON.stringify({ retention: 'keep', fixtureDirectory: dir, schema, browserPid: chrome.pid, origin }))
  let debug
  for (let i = 0; i < 150; i++) { try { debug = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').trim().split('\n'); break } catch { await new Promise(resolve => setTimeout(resolve, 100)) } }
  if (!debug) throw Error('fixture Chromium unavailable')
  const ws = `ws://127.0.0.1:${debug[0]}${debug[1]}`
  setup = await Cdp.connect(ws)
  const targetId = (await setup.call('Target.createTarget', { url: origin })).targetId
  await setup.attach(targetId)
  let frame, node
  for (let i = 0; i < 100; i++) {
    try {
      frame = (await setup.call('Page.getFrameTree')).frameTree.frame
      const root = (await setup.call('DOM.getDocument', { depth: -1, pierce: false })).root
      const find = item => item?.nodeName === 'INPUT' ? item : (item?.children ?? []).map(find).find(Boolean)
      node = find(root)
      if (frame.url.startsWith(origin) && node) break
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!node || !frame?.loaderId) throw Error('fixture page unavailable')
  const actor = { userId: 'fixture-owner', workspaceId: randomUUID(), botId: randomUUID(), subagentId: randomUUID() }
  await pool.query('INSERT INTO "user"(id) VALUES($1)', [actor.userId])
  await pool.query('INSERT INTO bots VALUES($1,$2,$3)', [actor.botId, actor.userId, actor.workspaceId])
  await pool.query(`INSERT INTO bot_subagents VALUES($1,$2,$3,$4,'running',$5,1)`, [actor.subagentId, actor.userId, actor.workspaceId, actor.botId, targetId])
  await pool.query(`INSERT INTO workspace_computer_policies VALUES($1,'ask',1)`, [actor.workspaceId])
  let dek, encryptionContext
  const kms = {
    async generate(context) { dek = randomBytes(32); encryptionContext = context; return { plaintext: Buffer.from(dek), wrapped: 'fixture-wrap' } },
    async decrypt(wrapped, context) { assert.equal(wrapped, 'fixture-wrap'); assert.deepEqual(context, encryptionContext); return Buffer.from(dek) },
  }
  const fixturePassword = randomBytes(24).toString('base64url')
  const store = new CredentialStore(pool, kms), challenge = await store.challenge(actor, origin)
  await store.save(actor, { nonce: challenge.nonce, origin, username: 'fixture-user', password: fixturePassword })
  const target = { targetId, origin, endpoint: 'https://fixture.e2b.app/', expiresAt: Date.now() + 60000, observedInput: { loaderId: frame.loaderId, backendNodeId: node.backendNodeId, credentialRole: 'password', epoch: 1, permissionVersion: 1 } }
  const lease = await store.lease(actor, origin, target, undefined, true)
  if (lease.status !== 'ready') throw Error('fixture lease unavailable')
  let ended = false
  const guard = { async begin() { return { cdpUrl: ws, targetId, guardToken: 'fixture-guard' } }, async end() { ended = true } }
  const result = await fillCredential(pool, lease.lease, { kms, guard, connect: async () => Cdp.connect(ws) })
  assert.deepEqual(result, { status: 'guarded', origin }); assert.equal(ended, false)
  verify = await Cdp.connect(ws); await verify.attach(targetId)
  assert.equal(await verify.evaluate("document.querySelector('#fixture').value"), fixturePassword)
  await assert.rejects(fillCredential(pool, lease.lease, { kms, guard, connect: async () => Cdp.connect(ws) }))
  console.log(JSON.stringify({ database: 'isolated PostgreSQL', browser: 'isolated Chromium', credential: 'synthetic', singleUse: 'pass', cdpInsert: 'pass', guard: 'simulated and retained', realGateway: false }))
} finally {
  void chrome // Retain all resources.
}
}
if (process.env.CREDENTIAL_TEST_RETAIN_RESOURCES !== '1') throw new Error('Credential database/browser fixture requires explicit resource retention')
await retainedFixture()
