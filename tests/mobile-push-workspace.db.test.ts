import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
const allowed = !!target && disposableDatabase(process.env, target)
if (process.env.REQUIRE_DB === '1' && !allowed) throw new Error('Phone push Workspace tests need isolated loopback *_e2e databases')

type Push = { to: string; title: string; body: string; data: Record<string, unknown> }
const pgCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined
  if ('code' in error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)) return error.code
  return 'cause' in error ? pgCode(error.cause) : undefined
}

test('phone delivery rechecks native sessions and the persisted Workspace with both pools at one', { skip: !allowed, timeout: 120_000 }, async t => {
  const app = new Pool({ connectionString: target, max: 1 })
  const workspace = new Pool({ connectionString: target, max: 1 })
  const admin = new Pool({ connectionString: target, max: 1 })
  const globals = globalThis as unknown as { mikkaPool?: Pool; workspacePool?: Pool }
  const previous = { app: globals.mikkaPool, workspace: globals.workspacePool }
  const oldEnvironment = { MIKKA_EDITION: process.env.MIKKA_EDITION, BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET, WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY }
  globals.mikkaPool = app; globals.workspacePool = workspace
  const origin = 'http://localhost:3100'
  process.env.MIKKA_EDITION = 'cloud'
  process.env.BETTER_AUTH_URL = origin
  process.env.BETTER_AUTH_SECRET ||= randomBytes(32).toString('hex')
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  const owner = 'phone-workspace-' + randomUUID(), peer = 'phone-peer-' + randomUUID()
  const personal = randomUUID(), alpha = randomUUID(), beta = randomUUID(), organizationId = randomUUID()
  const personalBot = randomUUID(), alphaBot = randomUUID(), betaBot = randomUUID(), foreignBot = randomUUID()
  const alphaIssue = randomUUID(), otherAlphaIssue = randomUUID(), betaIssue = randomUUID(), pendingIssue = randomUUID()
  const agent = randomUUID(), peerAgent = randomUUID()
  const alphaRun = randomUUID(), otherTaskRun = randomUUID(), betaRun = randomUUID(), peerRun = randomUUID()
  const token = 'ExpoPushToken[' + randomUUID().replaceAll('-', '') + ']'
  const peerToken = 'ExpoPushToken[' + randomUUID().replaceAll('-', '') + ']'
  const sent: { userId: string; message: { to: string[]; title: string; body: string; data: Record<string, unknown> } }[] = []
  const starts: string[] = []
  const backendIds = new Set<number>()
  let onSend: (() => Promise<void>) | undefined, partialFailure = false
  const originalFetch = globalThis.fetch
  const provider = mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== 'https://exp.host/--/api/v2/push/send') return originalFetch(input, init)
    const payload = JSON.parse(String(init?.body)) as Push[]
    assert.ok(Array.isArray(payload) && payload.length)
    // This is the real delivery implementation. Its SQL, including the
    // accepted receipt insert, must reuse the one occupied APP connection.
    const { pool } = await import('../lib/db')
    backendIds.add((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    await onSend?.()
    sent.push({ userId: String(payload[0].data.userId), message: { to: payload.map(item => item.to),
      title: payload[0].title, body: payload[0].body, data: payload[0].data } })
    return Response.json({ data: payload.map((_, index) => partialFailure && index === 1
      ? { status: 'error', details: { error: 'MessageRateExceeded' } }
      : { status: 'ok', id: randomUUID() }) })
  })
  const phonePushReceipts = async () => {}
  const workflow = mock.module(new URL('../workflows/phone-push-receipts/workflow.ts', import.meta.url).href,
    { namedExports: { phonePushReceipts } })
  const wake = mock.module('workflow/api', { namedExports: { start: async (started: unknown, args: unknown[]) => {
    // Other after-commit workflows (including audit retention) have their own arguments.
    if (started !== phonePushReceipts) return
    const id = String(args[0]); starts.push(id)
    const { pool } = await import('../lib/db')
    assert.equal((await pool.query('SELECT id FROM mobile_push_receipts WHERE id=$1', [id])).rowCount, 1)
  } } })
  t.after(async () => {
    provider.mock.restore(); wake.restore(); workflow.restore()
    globals.mikkaPool = previous.app; globals.workspacePool = previous.workspace
    await admin.query('DELETE FROM mobile_push_receipts WHERE user_id=ANY($1::text[])', [[owner, peer]])
    await admin.query('DELETE FROM enterprise_org_policy WHERE "organizationId"=$1', [organizationId])
    await admin.query('DELETE FROM mikka_organizations WHERE id=$1', [organizationId])
    await admin.query('DELETE FROM agent_runs WHERE id=ANY($1::uuid[])', [[alphaRun, otherTaskRun, betaRun, peerRun]])
    await admin.query('DELETE FROM issues WHERE id=ANY($1::uuid[])', [[alphaIssue, otherAlphaIssue, betaIssue, pendingIssue]])
    await admin.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [[agent, peerAgent]])
    await admin.query('DELETE FROM bots WHERE id=ANY($1::uuid[])', [[personalBot, alphaBot, betaBot, foreignBot]])
    await admin.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer]])
    await admin.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [[personal, alpha, beta]])
    await Promise.all([app.end(), workspace.end(), admin.end()])
    for (const [key, value] of Object.entries(oldEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  assert.equal((await admin.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
  for (const id of [owner, peer]) await admin.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Phone fixture\',$2,true,now(),now())', [id, id + '@example.invalid'])
  for (const [id, kind] of [[personal, 'personal'], [alpha, 'team'], [beta, 'team']]) {
    await admin.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Phone fixture\',$3)', [id, owner, kind])
    await admin.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,\'Phone fixture\',$3,\'admin\',\'active\')', [id, owner, owner + '@example.invalid'])
  }
  for (const [id, tenant, user] of [[personalBot, personal, owner], [alphaBot, alpha, owner], [betaBot, beta, owner], [foreignBot, alpha, peer]]) {
    await admin.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Phone fixture\')', [id, user, tenant])
  }
  await admin.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,\'Phone fixture\',$3,\'member\',\'active\')', [alpha, peer, peer + '@example.invalid'])
  for (const [id, tenant] of [[alphaIssue, alpha], [otherAlphaIssue, alpha], [betaIssue, beta], [pendingIssue, null]]) {
    await admin.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority) VALUES($1,$2,$3,\'Phone task fixture\',$4,\'todo\',\'normal\')',
      [id, owner, tenant, { type: 'doc' }])
  }
  for (const [id, user] of [[agent, owner], [peerAgent, peer]]) {
    await admin.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,\'codex\',\'Phone task fixture\')', [id, user])
  }
  for (const [id, user, agentId, issueId, botId] of [[alphaRun, owner, agent, alphaIssue, alphaBot],
    [otherTaskRun, owner, agent, otherAlphaIssue, alphaBot], [betaRun, owner, agent, betaIssue, betaBot],
    [peerRun, peer, peerAgent, alphaIssue, foreignBot]]) {
    await admin.query('INSERT INTO agent_runs(id,"userId","agentId","issueId","botId",status) VALUES($1,$2,$3,$4,$5,\'succeeded\')',
      [id, user, agentId, issueId, botId])
  }
  const { auth } = await import('../lib/auth')
  const context = await auth.$context
  const nativeSession = async (userId: string) => {
    const session = await context.internalAdapter.createSession(userId)
    assert.ok(session)
    return session
  }
  let ownerSession = await nativeSession(owner)
  const peerSession = await nativeSession(peer)
  for (const [user, value, sessionId] of [[owner, token, ownerSession.id], [peer, peerToken, peerSession.id]]) {
    await admin.query('INSERT INTO mobile_push_tokens(id,"userId","sessionId",token,platform) VALUES($1,$2,$3,$4,\'ios\')', [randomUUID(), user, sessionId, value])
  }
  const { pushReply } = await import('../lib/mobile-push')
  const { POST, DELETE } = await import('../app/api/mobile/push-tokens/route')
  const request = (method: 'POST' | 'DELETE', bearer: string, body: unknown, cookie?: string) => new Request(origin + '/api/mobile/push-tokens', {
    method, headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  const push = (bot = alphaBot) => pushReply(owner, bot, 'Isolated reply body', ['finished'])
  const targetPush = (issueId = alphaIssue, runId: string | null = alphaRun, bot = alphaBot) =>
    pushReply(owner, bot, 'Isolated task reply body', ['review'], { issueId, runId })
  const membership = (status: string) => admin.query('UPDATE mikka_workspace_members SET status=$3 WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner, status])
  const tokenRows = async () => (await admin.query('SELECT token,"userId","sessionId","deviceName" FROM mobile_push_tokens WHERE "userId"=ANY($1::text[]) ORDER BY token', [[owner, peer]])).rows
  const rebind = async () => {
    assert.equal((await POST(request('POST', ownerSession.token, { token, platform: 'ios' }))).status, 200)
    assert.equal((await admin.query('SELECT "sessionId" FROM mobile_push_tokens WHERE token=$1', [token])).rows[0].sessionId, ownerSession.id)
  }

  await t.test('personal and both shared origins reach only the current owner tokens', async t => {
    const raw = await workspace.connect()
    const reads = t.mock.method(raw, 'query')
    raw.release()
    for (const bot of [personalBot, alphaBot, betaBot]) await push(bot)
    const linkReads = reads.mock.calls.filter(({ arguments: [query] }) => {
      const sql = typeof query === 'string' ? query : query?.text
      return typeof sql === 'string' && /^select "organizationId" from "mikka_organization_workspaces" /i.test(sql)
    })
    assert.equal(linkReads.length, 3, 'each admitted phone reads its locked organization link once')
    assert.equal(sent.length, 3)
    assert.ok(sent.every(row => row.userId === owner && row.message.to.length === 1 && row.message.to[0] === token))
    assert.deepEqual(sent.map(row => row.message.data.botId), [personalBot, alphaBot, betaBot])
    assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1); assert.equal(backendIds.size, 1)
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM mobile_push_receipts WHERE user_id=$1', [owner])).rows[0].count, 3)
  })

  await t.test('current task targets carry their persisted Workspace and only the matching owned attempt', async () => {
    const before = sent.length
    const receipts = (await admin.query('SELECT count(*)::int AS count FROM mobile_push_receipts WHERE user_id=$1', [owner])).rows[0].count
    await targetPush()
    assert.deepEqual(sent.at(-1)?.message.data, { botId: alphaBot, serverUrl: sent[0].message.data.serverUrl,
      userId: owner, workspaceId: alpha, issueId: alphaIssue, runId: alphaRun })
    await targetPush(alphaIssue, null)
    assert.deepEqual(sent.at(-1)?.message.data, { botId: alphaBot, serverUrl: sent[0].message.data.serverUrl,
      userId: owner, workspaceId: alpha, issueId: alphaIssue })
    await targetPush(betaIssue, betaRun, betaBot)
    assert.equal(sent.length, before + 3)
    assert.equal(sent.at(-1)?.message.data.workspaceId, beta)
    assert.equal(sent.at(-1)?.message.data.issueId, betaIssue)
    assert.equal(sent.at(-1)?.message.data.runId, betaRun)
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM mobile_push_receipts WHERE user_id=$1', [owner])).rows[0].count, receipts + 3)
    assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1); assert.equal(backendIds.size, 1)
    await pushReply(owner, alphaBot, 'Isolated generic body', ['review'], null)
    assert.deepEqual(Object.keys(sent.at(-1)!.message.data).sort(), ['botId', 'serverUrl', 'userId'])
    assert.equal(sent.length, before + 4, 'an explicit null target preserves generic notification delivery')
  })

  await t.test('a member of both Workspaces cannot send a target from the other origin', async () => {
    const before = sent.length, destinations = await tokenRows(), wakesBefore = starts.length
    const receipts = (await admin.query('SELECT count(*)::int AS count FROM mobile_push_receipts WHERE user_id=$1', [owner])).rows[0].count
    await targetPush(betaIssue, betaRun, alphaBot)
    await targetPush(alphaIssue, alphaRun, betaBot)
    assert.equal(sent.length, before)
    assert.equal(starts.length, wakesBefore)
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM mobile_push_receipts WHERE user_id=$1', [owner])).rows[0].count, receipts)
    assert.deepEqual(await tokenRows(), destinations)
  })

  await t.test('pending, missing and deleted task targets are refused without falling back to the task body', async () => {
    assert.equal((await admin.query('SELECT "ownershipState","workspaceId" FROM issues WHERE id=$1', [pendingIssue])).rows[0].ownershipState, 'pending')
    const before = sent.length, destinations = await tokenRows()
    await targetPush(pendingIssue, null)
    await targetPush(randomUUID(), null)
    await admin.query('UPDATE issues SET content=$2 WHERE id=$1', [alphaIssue,
      { type: 'doc', attrs: { mikka: { deletedAt: new Date().toISOString() } } }])
    try { await targetPush() }
    finally { await admin.query('UPDATE issues SET content=$2 WHERE id=$1', [alphaIssue, { type: 'doc' }]) }
    assert.equal(sent.length, before)
    assert.deepEqual(await tokenRows(), destinations)
    await targetPush()
    assert.equal(sent.length, before + 1, 'a restored current task can deliver after a fresh read')
  })

  await t.test('a task target cannot name another task, tenant or owner attempt', async () => {
    const before = sent.length
    for (const runId of [otherTaskRun, betaRun, peerRun, randomUUID()]) {
      await targetPush(alphaIssue, runId)
      assert.equal(sent.length, before, 'a mismatched or missing run must not be sent as a generic notification')
    }
    await targetPush()
    assert.equal(sent.length, before + 1)
  })

  await t.test('a previously valid task target is refused after Workspace membership is revoked', async () => {
    const before = sent.length
    await membership('suspended')
    try { await targetPush(); assert.equal(sent.length, before) }
    finally { await membership('active') }
    await targetPush()
    assert.equal(sent.length, before + 1)
  })

  await t.test('removed membership, archived bots and another owner cannot deliver or edit tokens', async () => {
    const before = sent.length, destinations = await tokenRows()
    await membership('suspended'); await push(); await membership('active')
    await admin.query('UPDATE bots SET "archivedAt"=now() WHERE id=$1', [alphaBot])
    await push()
    await admin.query('UPDATE bots SET "archivedAt"=null WHERE id=$1', [alphaBot])
    await push(foreignBot)
    assert.equal(sent.length, before)
    assert.deepEqual(await tokenRows(), destinations)
  })

  await t.test('a decision made while authorized does not authorize a later delivery', async () => {
    const { executionWorkspace } = await import('../lib/execution-settings')
    assert.equal(await executionWorkspace(owner, alphaBot), alpha)
    await membership('suspended')
    const before = sent.length
    await push(); assert.equal(sent.length, before)
    await membership('active'); await push()
    assert.equal(sent.length, before + 1)
  })

  async function blockedDuringSend(sql: string | ((client: PoolClient) => Promise<unknown>), values: unknown[] = []) {
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
    onSend = async () => { entered.resolve(); await released.promise }
    const sending = push()
    await entered.promise
    const client = await admin.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout='100ms'")
      await assert.rejects(typeof sql === 'string' ? client.query(sql, values) : sql(client), error => pgCode(error) === '55P03')
    } finally {
      await client.query('ROLLBACK'); client.release()
      released.resolve(); await sending; onSend = undefined
    }
  }

  await t.test('a revocation waits for an admitted bounded send and prevents every later send', async () => {
    await blockedDuringSend('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner])
    await membership('suspended')
    const before = sent.length
    await push(); assert.equal(sent.length, before)
    await membership('active'); await push(personalBot)
    assert.equal(sent.length, before + 1, 'revoking one Workspace leaves the Personal origin intact')
  })

  await t.test('expired, unknown and foreign sessions never deliver or mutate a destination', async () => {
    const before = sent.length
    await admin.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [ownerSession.id])
    await push(); assert.equal(sent.length, before)
    await admin.query('UPDATE "session" SET "expiresAt"=now()+interval \'1 day\' WHERE id=$1', [ownerSession.id])
    for (const sessionId of [null, 'missing-' + randomUUID(), peerSession.id]) {
      await admin.query('UPDATE mobile_push_tokens SET "sessionId"=$2 WHERE token=$1', [token, sessionId])
      const snapshot = await tokenRows()
      await push(); assert.equal(sent.length, before)
      assert.deepEqual(await tokenRows(), snapshot)
    }
    await rebind(); await push()
    assert.equal(sent.length, before + 1)
  })

  await t.test('session deletion, reassignment and token replacement serialize behind delivery', async () => {
    await blockedDuringSend('DELETE FROM "session" WHERE id=$1', [ownerSession.id])
    await blockedDuringSend('UPDATE "session" SET "userId"=$2 WHERE id=$1', [ownerSession.id, peer])
    await blockedDuringSend('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [ownerSession.id])
    await blockedDuringSend('UPDATE mobile_push_tokens SET "userId"=$2,"sessionId"=$3 WHERE token=$1', [token, peer, peerSession.id])
    await admin.query('UPDATE "session" SET "userId"=$2 WHERE id=$1', [ownerSession.id, peer])
    const before = sent.length
    await push(); assert.equal(sent.length, before, 'the row now belongs to another person')
    await admin.query('UPDATE "session" SET "userId"=$2 WHERE id=$1', [ownerSession.id, owner])
    await admin.query('DELETE FROM "session" WHERE id=$1', [ownerSession.id])
    await push(); assert.equal(sent.length, before, 'a committed native logout revokes the phone without deleting its token')
    ownerSession = await nativeSession(owner)
    await rebind(); await push()
    assert.equal(sent.length, before + 1)
  })

  await t.test('registration accepts only the real native session and restores a legacy NULL token', async () => {
    await admin.query('UPDATE mobile_push_tokens SET "sessionId"=null WHERE token=$1', [token])
    const before = sent.length
    await push(); assert.equal(sent.length, before)
    await rebind()
    const { createLegacyPersonalAccessToken } = await import('../lib/tokens/store')
    const pat = await createLegacyPersonalAccessToken(owner, alpha, { name: 'Phone negative fixture', expiresAt: null })
    const signature = createHmac('sha256', context.secret).update(ownerSession.token).digest('base64')
    const cookie = context.authCookies.sessionToken.name + '=' + encodeURIComponent(ownerSession.token + '.' + signature)
    const snapshot = await tokenRows()
    assert.equal((await POST(request('POST', pat.token, { token, platform: 'ios' }, cookie))).status, 401)
    for (const extra of [{ sessionId: peerSession.id }, { userId: peer }, { principal: { kind: 'session', sessionId: peerSession.id } }]) {
      assert.equal((await POST(request('POST', ownerSession.token, { token, platform: 'ios', ...extra }))).status, 400)
    }
    assert.deepEqual(await tokenRows(), snapshot)
    const expired = await nativeSession(owner)
    await admin.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [expired.id])
    assert.equal((await POST(request('POST', expired.token, { token, platform: 'ios' }))).status, 401)
    const revoked = await nativeSession(owner)
    await admin.query('DELETE FROM "session" WHERE id=$1', [revoked.id])
    assert.equal((await POST(request('POST', revoked.token, { token, platform: 'ios' }))).status, 401)
    assert.deepEqual(await tokenRows(), snapshot)
    await push(); assert.equal(sent.length, before + 1)
  })

  await t.test('late sign-out and failed registration cannot delete or replace a newer binding', async () => {
    const old = ownerSession
    ownerSession = await nativeSession(owner)
    await rebind()
    assert.equal((await DELETE(request('DELETE', old.token, { token }))).status, 204)
    assert.equal((await admin.query('SELECT "sessionId" FROM mobile_push_tokens WHERE token=$1', [token])).rows[0].sessionId, ownerSession.id)
    const snapshot = await tokenRows(), before = sent.length
    const name = 'phone_registration_' + randomUUID().replaceAll('-', '')
    await admin.query('CREATE FUNCTION ' + name + '() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.token = \'' + token + '\' THEN RAISE EXCEPTION USING ERRCODE=\'P0001\', MESSAGE=\'Phone fixture rejects update\'; END IF; RETURN NEW; END; $$')
    await admin.query('CREATE TRIGGER ' + name + ' AFTER UPDATE ON mobile_push_tokens FOR EACH ROW EXECUTE FUNCTION ' + name + '()')
    try {
      await assert.rejects(POST(request('POST', old.token, { token, platform: 'android', deviceName: 'Must roll back' })), error => pgCode(error) === 'P0001')
      assert.deepEqual(await tokenRows(), snapshot)
      assert.equal(sent.length, before)
    } finally {
      await admin.query('DROP TRIGGER ' + name + ' ON mobile_push_tokens')
      await admin.query('DROP FUNCTION ' + name + '()')
    }
    assert.equal((await DELETE(request('DELETE', ownerSession.token, { token }))).status, 204)
    assert.equal((await admin.query('SELECT id FROM mobile_push_tokens WHERE token=$1', [token])).rowCount, 0)
    await rebind()
  })

  await t.test('partial provider failure commits accepted receipts on the same APP connection', async () => {
    const second = 'ExpoPushToken[' + randomUUID().replaceAll('-', '') + ']'
    await admin.query('INSERT INTO mobile_push_tokens(id,"userId","sessionId",token,platform) VALUES($1,$2,$3,$4,\'ios\')', [randomUUID(), owner, ownerSession.id, second])
    const before = (await admin.query('SELECT count(*)::int AS count FROM mobile_push_receipts WHERE user_id=$1', [owner])).rows[0].count
    const sentBefore = sent.length, wakesBefore = starts.length
    partialFailure = true
    try {
      await push()
      assert.equal(sent.length, sentBefore + 1)
      assert.equal(sent.at(-1)?.message.to.length, 2)
      assert.equal(starts.length, wakesBefore + 1)
      const receipts = await admin.query('SELECT id,secret FROM mobile_push_receipts WHERE user_id=$1', [owner])
      assert.equal(receipts.rowCount, before + 1, 'a different connection observes the accepted receipt after COMMIT')
      const receipt = receipts.rows.find(row => row.id === starts.at(-1)); assert.ok(receipt)
      const { openSecret } = await import('../lib/secrets/crypto')
      assert.equal(JSON.parse(openSecret(receipt.secret, 'mobile_push_receipts\0' + receipt.id)).length, 1)
      assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1); assert.equal(backendIds.size, 1)
    } finally {
      partialFailure = false
      await admin.query('DELETE FROM mobile_push_tokens WHERE token=$1', [second])
    }
  })

  // P2 adds a real organization policy without manufacturing SSO assurance.
  // Real OIDC and SCIM delivery cases live in enterprise/http.db.test.ts.
  const { revokeOrganizationLiveCapabilities } = await import('../lib/enterprise/live-store')
  const changePolicy = async (enforceSso: boolean) => {
    const client = await admin.connect()
    try {
      await client.query('BEGIN')
      try {
        await revokeOrganizationLiveCapabilities(client, organizationId)
        await client.query('INSERT INTO enterprise_org_policy ("organizationId","enforceSso") VALUES($1,$2) ON CONFLICT ("organizationId") DO UPDATE SET "enforceSso"=excluded."enforceSso"', [organizationId, enforceSso])
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error }
    } finally { client.release() }
  }

  await t.test('organization phone authorization belongs to the registered native receiver, not an ambient PAT', async () => {
    await admin.query('INSERT INTO mikka_organizations(id,name,"createdBy") VALUES($1,\'Phone organization\',$2)', [organizationId, owner])
    await admin.query('INSERT INTO mikka_organization_workspaces("workspaceId","organizationId") VALUES($1,$2)', [alpha, organizationId])
    await changePolicy(false)
    const { createLegacyPersonalAccessToken } = await import('../lib/tokens/store')
    const { getApiSession } = await import('../lib/api-auth')
    const { actAs } = await import('../lib/acting-user')
    const pat = await createLegacyPersonalAccessToken(owner, beta, { name: 'Phone ambient fixture', expiresAt: null })
    const caller = await getApiSession({ headers: new Headers({ authorization: 'Bearer ' + pat.token }), query: { disableCookieCache: true } })
    assert.ok(caller)
    const before = sent.length
    await actAs(caller.user, () => push())
    assert.equal(sent.length, before + 1)
    assert.deepEqual(sent.at(-1)?.message.to, [token])
    assert.equal(sent.at(-1)?.message.data.botId, alphaBot)
    const destinations = await tokenRows()
    await changePolicy(true)
    await actAs(caller.user, () => push())
    assert.equal(sent.length, before + 1, 'a real PAT never supplies assurance for its ordinary native phone session')
    assert.deepEqual(await tokenRows(), destinations)
    await push(personalBot)
    assert.equal(sent.length, before + 2, 'a policy for Alpha does not revoke the Personal origin')
    await changePolicy(false)
    // The target reader must keep this phone's explicit principal, even when
    // an ambient PAT selects Beta. Reuse the real policy and native session.
    const targetBefore = sent.length
    await actAs(caller.user, () => targetPush())
    assert.equal(sent.length, targetBefore + 1)
    assert.equal(sent.at(-1)?.message.data.workspaceId, alpha)
    assert.equal(sent.at(-1)?.message.data.issueId, alphaIssue)
    assert.equal(sent.at(-1)?.message.data.runId, alphaRun)
    await changePolicy(true)
    try {
      await actAs(caller.user, () => targetPush())
      assert.equal(sent.length, targetBefore + 1, 'a target hint cannot supply missing receiver SSO assurance')
      assert.deepEqual(await tokenRows(), destinations)
    } finally { await changePolicy(false) }
  })

  await t.test('organization policy and native session revocation wait for an admitted send with both pools at one', async () => {
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgname IN ('enterprise_live_session_deleted','enterprise_live_session_authority_changed') AND NOT tgisinternal")).rows[0].count, 2)
    await blockedDuringSend(async client => {
      await revokeOrganizationLiveCapabilities(client, organizationId)
      await client.query('UPDATE enterprise_org_policy SET "enforceSso"=true WHERE "organizationId"=$1', [organizationId])
    })
    await blockedDuringSend('DELETE FROM "session" WHERE id=$1', [ownerSession.id])
    await blockedDuringSend('UPDATE "session" SET "userId"=$2 WHERE id=$1', [ownerSession.id, peer])
    await blockedDuringSend('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [ownerSession.id])
    const before = sent.length, destinations = await tokenRows()
    await changePolicy(true)
    await push()
    assert.equal(sent.length, before)
    assert.deepEqual(await tokenRows(), destinations)
    await changePolicy(false)
    assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1); assert.equal(backendIds.size, 1)
  })

  await t.test('a policy committed after initial admission is rechecked under the Org barrier', async () => {
    const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>()
    const raw = await app.connect()
    const query = raw.query.bind(raw) as (...args: unknown[]) => unknown
    let paused = false
    const observe = mock.method(raw, 'query', ((...args: unknown[]) => {
      if (!paused && typeof args[0] === 'string' && args[0].includes('pg_advisory_xact_lock_shared')
        && Array.isArray(args[1]) && args[1][0] === 'enterprise-live-org:' + organizationId) {
        paused = true
        return (async () => { entered.resolve(); await proceed.promise; return query(...args) })()
      }
      return query(...args)
    }) as PoolClient['query'])
    raw.release()
    const before = sent.length, destinations = await tokenRows()
    const sending = push()
    await entered.promise
    try {
      await changePolicy(true)
      proceed.resolve(); await sending
      assert.equal(sent.length, before)
      assert.deepEqual(await tokenRows(), destinations)
    } finally {
      proceed.resolve(); await sending
      observe.mock.restore()
      await changePolicy(false)
    }
  })

  await t.test('an Org send never takes a session row lock behind its advisory barrier', async () => {
    // Pause only after the actual shared session advisory lock has completed.
    // A competing native DELETE then owns the row before its trigger waits
    // for the advisory. The sender must finish using MVCC, not request that row.
    const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>()
    const raw = await app.connect()
    const query = raw.query.bind(raw) as (...args: unknown[]) => unknown
    let paused = false
    const observe = mock.method(raw, 'query', ((...args: unknown[]) => {
      const result = query(...args)
      if (!paused && typeof args[0] === 'string' && args[0].includes('pg_advisory_xact_lock_shared')
        && Array.isArray(args[1]) && args[1][0] === 'enterprise-live-session:' + ownerSession.id) {
        paused = true
        assert.ok(result instanceof Promise)
        return result.then(async value => { entered.resolve(); await proceed.promise; return value })
      }
      return result
    }) as PoolClient['query'])
    raw.release()
    const before = sent.length
    const sending = push()
    await entered.promise
    const revoker = await admin.connect()
    let committed = false
    try {
      await revoker.query('BEGIN')
      await revoker.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'")
      assert.equal((await revoker.query('SELECT id FROM "session" WHERE id=$1 FOR UPDATE', [ownerSession.id])).rowCount, 1)
      const deleting = revoker.query('DELETE FROM "session" WHERE id=$1', [ownerSession.id])
      // Attach the rejection handler immediately; a lock failure remains an
      // assertion failure even when the admitted send is still finishing.
      const deleted = deleting.then(value => ({ value }), error => ({ error }))
      proceed.resolve()
      await sending
      assert.equal(sent.length, before + 1)
      const result = await deleted
      if ('error' in result) throw result.error
      assert.equal(result.value.rowCount, 1)
      await revoker.query('COMMIT'); committed = true
    } finally {
      proceed.resolve(); await sending
      if (!committed) await revoker.query('ROLLBACK')
      revoker.release(); observe.mock.restore()
    }
    await push()
    assert.equal(sent.length, before + 1, 'after DELETE commits no later send can reuse the dead native session')
    ownerSession = await nativeSession(owner)
    await rebind(); await push()
    assert.equal(sent.length, before + 2)
    assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
  })
})
