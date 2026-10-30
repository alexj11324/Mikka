import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, mock, test } from 'node:test'
import type { Pool } from 'pg'

// Settings backend: saved logins, activity and device removal, run through the
// real server actions and daemon routes against Postgres. Only the session
// (auth + next/headers) is mocked. CI runs it on the Actions loopback
// mikka_e2e; locally it needs MIKKA_LOCAL_DB_TESTS=1 and a loopback mikka_*e2e database.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  const ci = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && target.pathname === '/mikka_e2e'
  const local = process.env.MIKKA_LOCAL_DB_TESTS === '1' && /^\/mikka_[a-z0-9_]*e2e$/.test(target.pathname)
  if ((ci || local) && ['postgres:', 'postgresql:'].includes(target.protocol) && target.hostname === '127.0.0.1'
    && !target.search && !target.hash && process.env.MIKKA_DATABASE_URL === target.href && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching loopback test database')
const dbTest = databaseUrl ? test : test.skip

let sessionUser: string | null = null
const A = `test-settings-a-${randomUUID()}`
const B = `test-settings-b-${randomUUID()}`
const workspaceId = randomUUID()
const botA = randomUUID(), botB = randomUUID(), subagentA = randomUUID()
const agentA = randomUUID(), runA = randomUUID()
let pool: Pool
let actions: typeof import('../app/actions/settings-activity')
let deviceActions: typeof import('../app/actions/agents')
let link: typeof import('../lib/device-link')

before(async () => {
  if (!databaseUrl) return
  mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }) } })
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => sessionUser ? { user: { id: sessionUser } } : null } } } })
  ;({ pool } = await import('../lib/db'))
  actions = await import('../app/actions/settings-activity')
  deviceActions = await import('../app/actions/agents')
  link = await import('../lib/device-link')
  for (const id of [A, B]) await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,false,now(),now())`, [id, `${id}@example.invalid`])
  await pool.query(`INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$4,'Scout'),($3,$5,$4,'Other')`, [botA, A, botB, workspaceId, B])
  await pool.query(`INSERT INTO bot_subagents (id,"workspaceId","ownerId","botId",task,status) VALUES ($1,$2,$3,$4,'sign in','running')`, [subagentA, workspaceId, A, botA])
})

after(async () => {
  if (!databaseUrl) return
  await pool.query('DELETE FROM credential_fill_leases WHERE user_id = ANY($1)', [[A, B]])
  await pool.query('DELETE FROM device_credential_revocations WHERE "ownerId" = ANY($1)', [[A, B]])
  await pool.query('DELETE FROM device_tokens WHERE "userId" = ANY($1)', [[A, B]])
  await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [[A, B]])
  await pool.query('DELETE FROM device_repos WHERE "userId" = ANY($1)', [[A, B]])
  await pool.query('DELETE FROM agents WHERE "userId" = ANY($1)', [[A, B]])
  await pool.query('DELETE FROM devices WHERE "ownerId" = ANY($1)', [[A, B]])
  await pool.query('DELETE FROM pending_actions WHERE "userId" = ANY($1)', [[A, B]])
  await pool.query('DELETE FROM attention_matters WHERE "userId" = ANY($1)', [[A, B]])
  await pool.query('DELETE FROM attention_log WHERE "userId" = ANY($1)', [[A, B]])
  await pool.query('DELETE FROM bot_subagents WHERE "ownerId" = ANY($1)', [[A, B]])
  await pool.query('DELETE FROM bots WHERE "ownerId" = ANY($1)', [[A, B]])
  await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[A, B]])
  await pool.end()
})

async function saveLogin(userId: string, origin: string, username: string) {
  const id = randomUUID()
  await pool.query('INSERT INTO credentials (id,user_id,origin,username) VALUES ($1,$2,$3,$4)', [id, userId, origin, username])
  await pool.query(`INSERT INTO credential_secrets (credential_id,wrapped_dek,nonce,ciphertext,leak_hmac,leak_length) VALUES ($1,'synthetic','revision-1','synthetic','synthetic',8)`, [id])
  return id
}

dbTest('actions require a session', async () => {
  sessionUser = null
  assert.deepEqual(await actions.listSavedLogins(), { error: 'authRequired', params: undefined })
  assert.deepEqual(await actions.listActivity(), { error: 'authRequired', params: undefined })
  assert.deepEqual(await deviceActions.removeDevice(randomUUID()), { error: 'authRequired', params: undefined })
})

dbTest('saved logins: account and last Bot only, usage per login, owner-scoped deletion the broker honours', async () => {
  const github = await saveLogin(A, 'https://github.com', 'alex@example.com')
  const linear = await saveLogin(A, 'https://linear.app', 'alex')
  const foreign = await saveLogin(B, 'https://github.com', 'dana@example.com')
  await pool.query(`INSERT INTO credential_access_events (credential_id,user_id,bot_id,run_id,subagent_id,origin_seen,decision,ts) VALUES
    ($1,$2,$3,NULL,$4,'https://github.com','password_submitted',now()-interval '2 hours'),
    ($1,$2,$3,NULL,$4,'https://github.com','session_applied',now()-interval '1 hour'),
    ($1,$2,$3,NULL,$4,'https://github.com','denied_or_failed',now()-interval '1 minute'),
    ($5,$6,$7,NULL,NULL,'https://github.com','password_submitted',now())`, [github, A, botA, subagentA, foreign, B, botB])

  sessionUser = A
  const listed = await actions.listSavedLogins()
  assert.ok(!('error' in listed && listed.error))
  if (listed.error) return
  assert.deepEqual(listed.logins.map(login => [login.site, login.account, login.lastUsedBy]), [
    ['https://github.com', 'alex@example.com', 'Scout'], ['https://linear.app', 'alex', null],
  ])
  assert.ok(listed.logins[0].lastUsedAt && Date.now() - Date.parse(listed.logins[0].lastUsedAt) > 50 * 60_000, 'a failed attempt is not a use')
  assert.equal(listed.logins[1].lastUsedAt, null)
  assert.ok(!/revision-1|synthetic|password|secret/i.test(JSON.stringify(listed)), 'no secret material or key names leave the server')

  const usage = await actions.listSavedLoginUsage(github)
  if (usage.error) throw new Error(usage.error)
  assert.deepEqual(usage.uses.map(use => [use.result, use.botName, use.subagentId]), [
    ['denied_or_failed', 'Scout', subagentA], ['session_applied', 'Scout', subagentA], ['password_submitted', 'Scout', subagentA],
  ])
  assert.deepEqual(await actions.listSavedLoginUsage(foreign), { error: 'savedLoginNotFound', params: undefined })
  assert.deepEqual(await actions.deleteSavedLogin(foreign), { error: 'savedLoginNotFound', params: undefined })
  assert.deepEqual(await actions.deleteSavedLogin('not-a-uuid'), { error: 'savedLoginNotFound', params: undefined })

  // A lease taken before deletion, and any lease afterwards, can no longer fill.
  const { CredentialStore } = await import('../lib/credentials/store')
  const { fillCredential } = await import('../lib/credentials/broker')
  const kms = { generate: async () => { throw new Error('unused') }, decrypt: async () => { throw new Error('must not decrypt a deleted login') } }
  const store = new CredentialStore(pool, kms)
  const caller = { userId: A, workspaceId, botId: botA, subagentId: subagentA }
  const browser = { targetId: 'page', origin: 'https://linear.app', endpoint: 'https://example.invalid/rpc', expiresAt: Date.now() + 120_000 }
  const open = await store.lease(caller, 'https://linear.app', browser)
  assert.equal(open.status, 'ready')
  assert.deepEqual(await actions.deleteSavedLogin(linear), { id: linear })
  assert.deepEqual(await store.lease(caller, 'https://linear.app', browser), { status: 'needs_login', origin: 'https://linear.app' })
  if (open.status === 'ready') await assert.rejects(fillCredential(pool, open.lease, { kms, guard: { begin: async () => { throw new Error('no browser') }, end: async () => {} } }))
  assert.deepEqual(await actions.deleteSavedLogin(linear), { error: 'savedLoginNotFound', params: undefined })
  const after = await actions.listSavedLogins()
  assert.deepEqual(after.error ? after : after.logins.map(login => login.id), [github])

  sessionUser = B
  const other = await actions.listSavedLogins()
  assert.deepEqual(other.error ? other : other.logins.map(login => login.account), ['dana@example.com'])
})

dbTest('activity merges the three sources newest first, owner-only, with stable cursors', async () => {
  sessionUser = A
  const [{ id: credentialId }] = (await pool.query(`SELECT id FROM credentials WHERE user_id=$1 AND origin='https://github.com'`, [A])).rows
  const tie = new Date(Date.now() + 60_000)
  await pool.query(`INSERT INTO credential_access_events (credential_id,user_id,bot_id,subagent_id,origin_seen,decision,ts) VALUES
    ($1,$2,$3,$4,'https://github.com','input_inserted_guarded',$5),($1,$2,$3,$4,'https://github.com','password_submitted',$5)`, [credentialId, A, botA, subagentA, tie])
  const approved = randomUUID(), declined = randomUUID(), waiting = randomUUID(), automatic = randomUUID(), foreign = randomUUID()
  await pool.query(`INSERT INTO pending_actions (id,"userId",action,input,status,"decidedAt","operationBinding","createdAt") VALUES
    ($1,$6,'send_email','{"to":["recipient@example.org"],"subject":"Hi","body":"secret body"}','done',now()-interval '30 minutes',$8,now()-interval '40 minutes'),
    ($2,$6,'approve_repository_push','{"repo":"https://github.com/acme/app","remoteKey":"github.com/acme/app","permission":"push_to_origin"}','declined',now()-interval '20 minutes',NULL,now()-interval '40 minutes'),
    ($3,$6,'send_email','{}','pending',NULL,NULL,now()),
    ($4,$6,'send_email','{}','running',NULL,NULL,now()),
    ($5,$7,'send_email','{}','declined',now(),NULL,now())`, [approved, declined, waiting, automatic, foreign, A, B, JSON.stringify({ run: { runId: runA, botId: botA, workspaceId, policyVersion: 1, decision: 'ask' } })])
  const matter = randomUUID(), foreignMatter = randomUUID()
  await pool.query(`INSERT INTO attention_matters (id,"userId","matterKey",source,title,url,level,assessment,evidence,state) VALUES
    ($1,$3,'gmail:1','gmail','Invoice overdue','https://mail.example.com/1','high','{}','{}','notified'),
    ($2,$4,'gmail:2','gmail','Not yours','https://mail.example.com/2','high','{}','{}','notified')`, [matter, foreignMatter, A, B])
  await pool.query(`INSERT INTO attention_log (id,"userId","matterId",action,spends,reason,"createdAt") VALUES
    ($1,$3,$4,'notify',true,'due tomorrow',now()-interval '10 minutes'),
    ($2,$3,$4,'quiet',false,'not now',now()-interval '5 minutes'),
    ($5,$6,$7,'notify',true,'other',now())`, [randomUUID(), randomUUID(), A, matter, randomUUID(), B, foreignMatter])

  const all = await actions.listActivity({ filter: 'all', limit: 100 })
  if (all.error) throw new Error(all.error)
  const kinds = all.items.map(item => item.kind)
  assert.equal(kinds.filter(kind => kind === 'credential_use').length, 5)
  assert.equal(kinds.filter(kind => kind === 'external_action').length, 2)
  assert.equal(kinds.filter(kind => kind === 'coordinator_reminder').length, 1)
  assert.equal(all.nextCursor, null)
  const times = all.items.map(item => Date.parse(item.at))
  assert.deepEqual(times, [...times].sort((x, y) => y - x), 'newest first')
  const serialized = JSON.stringify(all)
  for (const leak of [B, botB, foreignMatter, foreign, 'Not yours', 'secret body', 'recipient@example.org']) assert.ok(!serialized.includes(leak), `must not expose ${leak}`)

  const sent = all.items.find(item => item.target.pendingActionId === approved)!
  assert.deepEqual({ summary: sent.summary, botName: sent.botName, runId: sent.target.runId, decidedBy: sent.decidedBy },
    { summary: { kind: 'external_action', action: 'send_email', decision: 'approved', status: 'done', site: null, repository: null }, botName: 'Scout', runId: runA, decidedBy: 'user' })
  const push = all.items.find(item => item.target.pendingActionId === declined)!
  assert.deepEqual(push.summary, { kind: 'external_action', action: 'approve_repository_push', decision: 'declined', status: 'declined', site: null, repository: 'https://github.com/acme/app' })
  const reminder = all.items.find(item => item.kind === 'coordinator_reminder')!
  assert.deepEqual({ summary: reminder.summary, target: reminder.target, decidedBy: reminder.decidedBy }, {
    summary: { kind: 'coordinator_reminder', title: 'Invoice overdue', source: 'gmail', level: 'high', reason: 'due tomorrow' },
    target: { runId: null, subagentId: null, issueId: null, pendingActionId: null, matterId: matter, url: 'https://mail.example.com/1' },
    decidedBy: 'coordinator',
  })
  const use = all.items.find(item => item.kind === 'credential_use')!
  assert.deepEqual({ summary: use.summary, botName: use.botName, subagentId: use.target.subagentId, decidedBy: use.decidedBy }, {
    summary: { kind: 'credential_use', site: 'https://github.com', account: 'alex@example.com', credentialId, result: use.summary.kind === 'credential_use' ? use.summary.result : 'x' },
    botName: 'Scout', subagentId: subagentA, decidedBy: null,
  })

  // Paging two at a time visits every item once, including the identical timestamps.
  const seen: string[] = []
  let cursor: string | null = null
  do {
    const page = await actions.listActivity({ filter: 'all', cursor, limit: 2 })
    if (page.error) throw new Error(page.error)
    seen.push(...page.items.map(item => item.id))
    cursor = page.nextCursor
  } while (cursor)
  assert.deepEqual(seen, all.items.map(item => item.id))

  const accounts = await actions.listActivity({ filter: 'accounts' })
  assert.ok(!accounts.error && accounts.items.every(item => item.kind !== 'coordinator_reminder') && accounts.items.length === 7)
  const reminders = await actions.listActivity({ filter: 'reminders' })
  assert.deepEqual(reminders.error ? reminders : reminders.items.map(item => item.target.matterId), [matter])
  assert.deepEqual(await actions.listActivity({ cursor: 'forged' }), { error: 'validationGeneric', params: undefined })

  sessionUser = B
  const theirs = await actions.listActivity()
  if (theirs.error) throw new Error(theirs.error)
  assert.deepEqual(theirs.items.map(item => item.kind).sort(), ['coordinator_reminder', 'credential_use', 'external_action'])
  assert.ok(!JSON.stringify(theirs).includes(A))
})

async function daemonCall(path: string, token: string, body: unknown, deviceId?: string) {
  const request = new Request(`http://localhost${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!deviceId) return (await import('../app/v1/devices/register/route')).POST(request)
  return (await import('../app/v1/devices/[deviceId]/heartbeat/route')).POST(request, { params: Promise.resolve({ deviceId }) })
}

async function mintToken(userId: string) {
  const token = link.newDeviceToken()
  await pool.query('INSERT INTO device_tokens (id,"userId",name,"tokenHash") VALUES ($1,$2,$3,$4)', [randomUUID(), userId, 'test', link.hashDeviceToken(token)])
  return token
}

const registration = (deviceId?: string) => ({ name: 'laptop-host', platform: 'darwin', arch: 'arm64', daemonVersion: '1', protocolVersion: 2, harnesses: [], ...(deviceId ? { deviceId } : {}) })

dbTest('devices: rename is owner-only and survives re-register; removal waits for live threads, revokes the daemon and keeps history', async () => {
  const token = await mintToken(A)
  const registered = await daemonCall('/v1/devices/register', token, registration())
  assert.equal(registered.status, 200)
  const { deviceId } = await registered.json() as { deviceId: string }
  const bystander = await mintToken(A)

  sessionUser = A
  assert.deepEqual(await deviceActions.renameDevice(deviceId, 'x'.repeat(61)), { error: 'deviceNameTooLong', params: undefined })
  assert.deepEqual(await deviceActions.renameDevice(deviceId, '   '), { error: 'validationNameRequired', params: undefined })
  assert.deepEqual(await deviceActions.renameDevice(deviceId, '  Studio Mac  '), { id: deviceId, name: 'Studio Mac' })
  assert.equal((await daemonCall('/v1/devices/register', token, registration(deviceId))).status, 200)
  assert.equal((await pool.query('SELECT name FROM devices WHERE id=$1', [deviceId])).rows[0].name, 'Studio Mac', 'daemon re-register keeps the chosen name')
  sessionUser = B
  assert.deepEqual(await deviceActions.renameDevice(deviceId, 'Mine now'), { error: 'deviceNotFound', params: undefined })
  assert.deepEqual(await deviceActions.removeDevice(deviceId), { error: 'deviceNotFound', params: undefined })

  // History: an agent, a repository and a finished run on this device; plus one live run.
  await pool.query(`INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,'codex',$3,$4)`, [agentA, A, `codex ${deviceId}`, deviceId])
  const repoId = randomUUID()
  await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,'github.com/acme/app')`, [repoId, deviceId, A])
  await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","deviceRepoId",status) VALUES ($1,$2,$3,$4,$5,'succeeded'),($6,$2,$3,$4,$5,'running')`, [runA, A, agentA, deviceId, repoId, randomUUID()])
  sessionUser = A
  assert.deepEqual(await deviceActions.removeDevice(deviceId), { error: 'deviceHasActiveRuns', params: undefined })
  assert.equal((await daemonCall(`/v1/devices/${deviceId}/heartbeat`, token, {}, deviceId)).status, 400, 'still authorized while refused (invalid body only)')
  await pool.query(`UPDATE agent_runs SET status='stopped' WHERE "deviceId"=$1 AND status='running'`, [deviceId])

  assert.deepEqual(await deviceActions.removeDevice(deviceId), { id: deviceId, revokedTokens: 1 })
  assert.deepEqual(await deviceActions.removeDevice(deviceId), { error: 'deviceNotFound', params: undefined })

  // The removed device's daemon is locked out of every /v1/devices call.
  assert.equal((await daemonCall(`/v1/devices/${deviceId}/heartbeat`, token, { harnesses: [], runs: [] }, deviceId)).status, 401)
  assert.equal((await daemonCall('/v1/devices/register', token, registration(deviceId))).status, 401)
  const commands = await import('../app/v1/devices/[deviceId]/commands/route')
  const poll = await commands.GET(new Request(`http://localhost/v1/devices/${deviceId}/commands`, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ deviceId }) })
  assert.equal(poll.status, 401)

  // History stays intact; the device is gone from settings and gets no work.
  const run = (await pool.query('SELECT "deviceId","deviceRepoId","agentId" FROM agent_runs WHERE id=$1', [runA])).rows[0]
  assert.deepEqual(run, { deviceId, deviceRepoId: repoId, agentId: agentA })
  const tomb = (await pool.query('SELECT name,enabled,"removedAt" FROM devices WHERE id=$1', [deviceId])).rows[0]
  assert.equal(tomb.name, 'Studio Mac'); assert.equal(tomb.enabled, false); assert.ok(tomb.removedAt)
  assert.equal((await pool.query('SELECT "deviceId" FROM agents WHERE id=$1', [agentA])).rows[0].deviceId, null)
  const devicesNow = await deviceActions.listDevices()
  assert.ok(!devicesNow.some(device => device.id === deviceId))
  assert.deepEqual(await deviceActions.renameDevice(deviceId, 'Back'), { error: 'deviceNotFound', params: undefined })
  assert.deepEqual(await deviceActions.setDeviceEnabled({ deviceId, enabled: true }), { success: true })
  assert.equal((await pool.query('SELECT enabled FROM devices WHERE id=$1', [deviceId])).rows[0].enabled, false, 'a removed device cannot be re-enabled')

  // Another credential of the same person is untouched and cannot revive the tombstone.
  const fresh = await daemonCall('/v1/devices/register', bystander, registration(deviceId))
  assert.equal(fresh.status, 200)
  assert.notEqual((await fresh.json() as { deviceId: string }).deviceId, deviceId)
  assert.equal((await daemonCall(`/v1/devices/${deviceId}/heartbeat`, bystander, { harnesses: [], runs: [] }, deviceId)).status, 404)
})

dbTest('device token links are recorded only for owned, present devices', async () => {
  const token = await mintToken(B)
  const [{ id: tokenId }] = (await pool.query('SELECT id FROM device_tokens WHERE "tokenHash"=$1', [link.hashDeviceToken(token)])).rows
  const caller = { userId: B, tokenId }
  assert.equal(await link.linkDeviceToken(caller, 'not-a-uuid'), false)
  const [{ id: aDevice }] = (await pool.query(`SELECT id FROM devices WHERE "ownerId"=$1 AND "removedAt" IS NULL LIMIT 1`, [A])).rows
  assert.equal(await link.linkDeviceToken(caller, aDevice), false, "another person's device")
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM device_token_devices WHERE "tokenId"=$1', [tokenId])).rows[0].n, 0)
})
