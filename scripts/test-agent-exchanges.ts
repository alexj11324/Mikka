import assert from 'node:assert/strict'
import { randomUUID, createHash, createHmac } from 'node:crypto'
import { Pool } from 'pg'
import { writeFile, mkdir } from 'node:fs/promises'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { groupDirectory } from '../lib/group-conversations-directory'
import { handleGroup } from '../lib/group-conversations-store'
import { handleGroupWorkerRequest } from '../lib/group-worker-route'
import { handleConversationLink } from '../lib/conversation-exchanges'
import { withExchangeReadAuthority } from '../lib/conversation-exchange-authority'
import { dispatchReviewWork } from '../lib/group-review-runtime'
import { claimGroupReview, groupMailboxAdapter } from '../lib/group-mailbox-runtime'

const connectionString = process.env.EXCHANGE_TEST_DATABASE_URL
if (!connectionString) throw new Error('EXCHANGE_TEST_DATABASE_URL required (dedicated synthetic PG only)')
const target = new URL(connectionString)
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/mikka_exchange') throw new Error('Refusing a non-isolated database')
const pool = new Pool({ connectionString, max: 16 })
const startedAt = new Date().toISOString()
let completed = false
const evidence: { name: string; result: string }[] = []
let recordingBrowser: Browser | undefined, recordingContext: BrowserContext | undefined, recordingPage: Page | undefined
async function check(name: string, fn: () => Promise<void>) {
  await fn(); evidence.push({ name, result: 'pass' }); console.log(`PASS ${name}`)
  if (recordingPage) {
    await recordingPage.evaluate(label => { const line = document.createElement('p'); line.textContent = `PASS ${label}`; document.body.append(line) }, name)
    await recordingPage.waitForTimeout(150)
  }
}
const suffix = randomUUID(), owner = `exchange-owner-${suffix}`, member = `exchange-member-${suffix}`, outsider = `exchange-outsider-${suffix}`
const workspace = randomUUID(), foreignWorkspace = randomUUID(), device = randomUUID(), a = randomUUID(), b = randomUUID(), privateAgent = randomUUID()
const q = pool.query.bind(pool)
const httpOrigin = process.env.EXCHANGE_HTTP_ORIGIN
if (httpOrigin && !['http://localhost:3110','http://127.0.0.1:3110'].includes(httpOrigin)) throw new Error('Only the isolated Next server is permitted')
const cookies = new Map<string, string>()
let deviceBearer = ''
async function http(path: string, user: string | null, method = 'GET', body?: unknown, origin?: string | null) {
  const response = await fetch(`${httpOrigin}/mikka${path}`, { method, headers: {
    ...(user ? { cookie: cookies.get(user)! } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(origin ? { origin } : {}),
  }, ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) })
  assert.equal(response.headers.get('cache-control')?.includes('no-store') ?? response.status === 405, true)
  return { status: response.status, body: await response.json().catch(() => null) }
}
const directory = groupDirectory({
  async activeUsers(w, ids) { return (await q('SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status=\'active\'', [w, ids])).rows.map(r => r.userId) },
  async ownedAgents(user, ids, client) { return (await (client ?? pool).query('SELECT id FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])', [user, ids])).rows.map(r => r.id) },
})
const groupReq = { userId: owner, method: 'GET' as const, resource: 'conversations' as const, origin: null, host: 'localhost:3110' }
const group = (changes: Record<string, unknown>) => {
  const req = { ...groupReq, ...changes } as any
  if (httpOrigin) {
    const params = new URLSearchParams()
    for (const key of ['before', 'limit', 'workspaceId']) if (req[key] != null) params.set(key, req[key])
    return http(`/api/conversations${req.id ? `/${req.id}/${req.resource}` : ''}?${params}`, req.userId, req.method, req.body, req.origin)
  }
  return handleGroup(pool, directory, req)
}
const link = (id: string, changes: Record<string, unknown> = {}) => {
  const req = { userId: member, id, method: 'GET', origin: null, host: 'localhost:3110', ...changes } as any
  if (httpOrigin) {
    const params = new URLSearchParams()
    if (req.before) params.set('before', req.before)
    if (req.limit) params.set('limit', req.limit)
    return http(`/api/conversation-links/${id}${req.method === 'DELETE' ? '' : '/messages'}?${params}`, req.userId, req.method, undefined, req.origin)
  }
  return handleConversationLink(pool, directory, req)
}
async function makeGroup() {
  const result = await group({ method: 'POST', body: JSON.stringify({ workspaceId: workspace, title: 'Synthetic exchange group', members: [{ memberType: 'user', memberId: member }, { memberType: 'agent', memberId: a }, { memberType: 'agent', memberId: b }] }) })
  assert.equal(result.status, 201)
  return (result.body as { id: string }).id
}
async function makeWork(g: string, agentId = a, requester = owner) {
  const sent = await group({ userId: requester, id: g, resource: 'messages', method: 'POST', body: JSON.stringify({ body: 'Explicit synthetic request', mentions: [{ memberType: 'agent', memberId: agentId }] }) })
  assert.equal(sent.status, 201)
  const trigger = (sent.body as { id: string }).id
  const work = (await q('SELECT * FROM conversation_work WHERE "triggerMessageId"=$1 AND "agentId"=$2', [trigger, agentId])).rows[0]
  await dispatchReviewWork(pool, directory, groupMailboxAdapter(pool), work.id)
  const claim = await claimGroupReview(pool, directory, owner, device, work.id)
  assert.equal(claim.status, 'claimed')
  return { workId: work.id as string, triggerMessageId: trigger, claimEpoch: claim.claimEpoch! }
}
async function send(work: Awaited<ReturnType<typeof makeWork>>, exchangeId = randomUUID(), changes = {}) {
  const input = { ...work, exchangeId, messageId: randomUUID(), toAgentId: b, body: 'Scoped synthetic exchange', ...changes }
  const request = new Request('http://localhost:3110/worker', { method: 'POST', body: JSON.stringify({ action: 'exchange', runId: work.workId, exchange: input }) })
  const response = httpOrigin ? await fetch(`${httpOrigin}/mikka/v1/devices/${device}/group-reviews`, { method: 'POST', headers: { authorization: `Bearer ${deviceBearer}`, 'content-type': 'application/json' }, body: await request.text() }) : await handleGroupWorkerRequest(request, device, { pool, directory, authenticate: async () => ({ userId: owner }) })
  return { status: response.status, body: await response.json(), input }
}
async function main() {
try {
  if (process.env.EXCHANGE_REQUIRE_CLEAN === '1') execFileSync('git', ['diff', '--exit-code', 'HEAD'])
  if (process.env.EXCHANGE_RECORDING_DIR) {
    if (!httpOrigin) throw new Error('Recording requires actual Next HTTP')
    await mkdir(process.env.EXCHANGE_RECORDING_DIR, { recursive: true })
    recordingBrowser = await chromium.launch(process.env.EXCHANGE_CHROMIUM_PATH ? { executablePath: process.env.EXCHANGE_CHROMIUM_PATH } : {})
    recordingContext = await recordingBrowser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: process.env.EXCHANGE_RECORDING_DIR, size: { width: 1440, height: 1000 } } })
    recordingPage = await recordingContext.newPage()
    await recordingPage.setContent('<html><body style="font:18px monospace;padding:24px"><h1>Agent exchange backend acceptance</h1><p>Actual compiled Next HTTP + isolated PostgreSQL + synthetic sessions.</p><p>API test console; this is not the product UI or production acceptance.</p></body></html>')
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    await recordingPage.evaluate(value => { const line = document.createElement('p'); line.textContent = `Source SHA: ${value}`; document.body.append(line) }, sha)
  }
  if (httpOrigin) {
    const secret = process.env.BETTER_AUTH_SECRET
    if (!secret) throw new Error('Synthetic Next auth secret required')
    for (const user of [owner, member, outsider]) {
      const token = randomUUID()
      await q(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Synthetic exchange',$2,true,now(),now())`, [user, `${user}@example.invalid`])
      await q(`INSERT INTO "session" (id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval '1 hour',now(),now())`, [randomUUID(), user, token])
      cookies.set(user, `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', secret).update(token).digest('base64')}`)}`)
    }
    deviceBearer = `orv_${randomUUID()}`
    await q('INSERT INTO device_tokens (id,"userId","tokenHash",name) VALUES ($1,$2,$3,\'Synthetic exchange only\')', [randomUUID(), owner, createHash('sha256').update(deviceBearer).digest('hex')])
  }
  await q('INSERT INTO devices (id,"ownerId",name,platform) VALUES ($1,$2,\'Synthetic exchange device\',\'linux\')', [device, owner])
  for (const [id, name, user] of [[a, 'Exchange A', owner], [b, 'Exchange B', owner], [privateAgent, 'Private sentinel', outsider]]) await q('INSERT INTO agents (id,"userId",name,harness,instructions,"deviceId") VALUES ($1,$2,$3,\'codex\',\'PRIVATE_SENTINEL_NEVER_SHARE\',$4)', [id, user, name, device])
  for (const user of [owner, member, outsider]) await q('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,\'Synthetic\',$3,\'member\',\'active\')', [workspace, user, `${user}@example.invalid`])
  const g = await makeGroup(), work = await makeWork(g)
  let first: Awaited<ReturnType<typeof send>>
  await check('authenticated run creates one fresh scoped DM with two agent members', async () => {
    first = await send(work)
    assert.equal(first.status, 200)
    const scope = (await q('SELECT * FROM conversation_exchange_scopes WHERE "linkId"=$1', [first.input.exchangeId])).rows[0]
    const members = (await q('SELECT "memberType" FROM conversation_members WHERE "conversationId"=$1', [scope.dmId])).rows
    assert.deepEqual(members.map(m => m.memberType), ['agent', 'agent'])
  })
  const id = first!.input.exchangeId
  await check('parallel replays are idempotent; changed key payload conflicts', async () => {
    const replay = await Promise.all(Array.from({ length: 8 }, () => send(work, id, first.input)))
    assert.ok(replay.every(r => r.status === 200 && r.body.duplicate), JSON.stringify(replay.map(r => ({ status: r.status, body: r.body }))))
    assert.equal((await send(work, id, { ...first.input, body: 'changed' })).status, 409)
    assert.equal((await q('SELECT * FROM conversation_exchange_messages WHERE "linkId"=$1', [id])).rowCount, 1)
  })
  await check('continuous segment updates one marker; range pagination and sender allowlist', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await send(work, id, { body: `Scoped message ${i}` })).status, 200)
    const response = await link(id, { limit: '2' })
    assert.equal(response.status, 200)
    const body = response.body as any
    assert.equal(body.readOnly, true); assert.equal(body.messages.length, 2); assert.equal(body.nextBefore, '3')
    assert.equal(body.messages[0].senderName, 'Exchange A'); assert.equal(body.messages[0].senderAvatar, null)
    assert.ok(!JSON.stringify(body).includes('PRIVATE_SENTINEL'))
    const next = (await link(id, { before: body.nextBefore, limit: '2' })).body as any
    assert.deepEqual(next.messages.map((m: any) => m.position), ['2', '1'])
    const page = (await group({ id: g, resource: 'messages' })).body as any
    assert.equal(page.items.filter((i: any) => i.type === 'agent_exchange').length, 1)
    assert.equal(page.items[0].count, '4')
    const list = (await group({ userId: member })).body as any
    assert.equal(list.conversations.find((c: any) => c.id === g).unreadCount, '1')
    const markerPage = (await group({ id: g, resource: 'messages', limit: '1' })).body as any
    assert.equal(markerPage.items[0].type, 'agent_exchange'); assert.equal(markerPage.nextBefore, '2')
    const textPage = (await group({ id: g, resource: 'messages', limit: '1', before: markerPage.nextBefore })).body as any
    assert.equal(textPage.messages[0].position, '1'); assert.equal(textPage.nextBefore, null)
  })
  await check('outsider/workspace-only users, malformed IDs and anonymous reads are denied', async () => {
    assert.equal((await link(id, { userId: outsider })).status, 404)
    assert.equal((await link(id, { userId: null })).status, 401)
    assert.equal((await link('bad')).status, 404)
    for (const limit of ['0', '101', '1.1', '-1']) assert.equal((await link(id, { limit })).status, 422)
    const scope = (await q('SELECT * FROM conversation_exchange_scopes WHERE "linkId"=$1', [id])).rows[0]
    assert.equal((await group({ id: scope.dmId, resource: 'messages' })).status, 404)
    assert.equal((await group({ id: scope.dmId, resource: 'messages', method: 'POST', body: '{"body":"forged"}' })).status, 404)
    assert.equal((await link(id, { method: 'POST' })).status, 405)
  })
  await check('source removal denies reads; rejoin permits current members', async () => {
    await group({ id: g, resource: 'members', method: 'DELETE', body: JSON.stringify({ memberType: 'user', memberId: member }) })
    assert.equal((await link(id)).status, 404)
    await group({ id: g, resource: 'members', method: 'POST', body: JSON.stringify({ memberType: 'user', memberId: member }) })
    assert.equal((await link(id)).status, 200)
  })
  await check('workspace suspension denies even current conversation members', async () => {
    await q('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, member])
    assert.equal((await link(id)).status, 404)
    await q('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, member])
    assert.equal((await link(id)).status, 200)
  })
  await check('cross-source, private agent and forged runtime/sender inputs cannot publish', async () => {
    const other = await makeGroup(), otherWork = await makeWork(other)
    assert.equal((await send(otherWork, id)).status, 404)
    assert.equal((await send(work, randomUUID(), { toAgentId: privateAgent })).status, 403)
    assert.equal((await send(work, randomUUID(), { authorId: b })).status, 422)
    assert.equal((await send(work, randomUUID(), { triggerMessageId: randomUUID() })).status, 403)
    assert.equal((await send(work, randomUUID(), { claimEpoch: 99 })).status, 409)
    await q('UPDATE conversations SET "workspaceId"=$2 WHERE id=$1', [other, foreignWorkspace])
    assert.equal((await send(otherWork)).status, 403)
  })
  await check('link/DM provenance reparenting rejected; bound/count tampering fails closed', async () => {
    await assert.rejects(q('UPDATE conversation_links SET "linkedConversationId"=$2 WHERE id=$1', [id, randomUUID()]), /immutable/)
    await assert.rejects(q('UPDATE conversation_exchange_scopes SET "sourceId"=$2 WHERE "linkId"=$1', [id, randomUUID()]), /immutable/)
    await q('UPDATE conversation_links SET "lastPosition"=999,"messageCount"=999 WHERE id=$1', [id])
    assert.equal((await link(id)).status, 404)
    await q('UPDATE conversation_links SET "lastPosition"=4,"messageCount"=4 WHERE id=$1', [id])
    assert.equal((await link(id)).status, 200)
  })
  await check('workspace authority holds suspension until the admitted read completes', async () => {
    let release!: () => void, entered!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
    const reading = withExchangeReadAuthority(pool, async lockedDirectory => {
      assert.equal((await handleConversationLink(pool, lockedDirectory, { userId: member, id, method: 'GET', host: 'localhost:3110', origin: null })).status, 200)
      entered(); await barrier
    })
    await ready
    let committed = false
    const suspension = q('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, member]).then(() => { committed = true })
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(committed, false)
    release(); await reading; await suspension
    assert.equal((await link(id)).status, 404)
    await q('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, member])
  })
  await check('owner-only Origin-protected revoke is permanent and replay-safe', async () => {
    assert.equal((await link(id, { method: 'DELETE' })).status, 403)
    assert.equal((await link(id, { userId: owner, method: 'DELETE', origin: 'https://evil.test' })).status, 403)
    assert.equal((await link(id, { userId: owner, method: 'DELETE', origin: 'http://localhost:3110' })).status, 200)
    assert.equal((await link(id, { userId: owner, method: 'DELETE' })).status, 200)
    assert.equal((await link(id)).status, 404)
    assert.equal((await send(work, id)).status, 404)
    await assert.rejects(q('UPDATE conversation_exchange_scopes SET "revokedAt"=NULL WHERE "linkId"=$1', [id]), /immutable/)
    const page = (await group({ id: g, resource: 'messages' })).body as any
    assert.equal(page.items.filter((i: any) => i.type === 'agent_exchange').length, 0)
  })
  await check('requester leave/rejoin cannot revive a prior membership epoch', async () => {
    const epochGroup = await makeGroup(), epochWork = await makeWork(epochGroup, a, member)
    const created = await send(epochWork)
    assert.equal(created.status, 200)
    await group({ id: epochGroup, resource: 'members', method: 'DELETE', body: JSON.stringify({ memberType: 'user', memberId: member }) })
    await group({ id: epochGroup, resource: 'members', method: 'POST', body: JSON.stringify({ memberType: 'user', memberId: member }) })
    assert.equal((await link(created.input.exchangeId)).status, 404)
    assert.equal((await send(epochWork)).status, 409)
  })
  await check('two authenticated Agents append to the same trigger-bound exchange', async () => {
    const mutualGroup = await makeGroup(), firstWork = await makeWork(mutualGroup)
    const created = await send(firstWork)
    assert.equal(created.status, 200)
    const command = { action: 'complete', runId: firstWork.workId, reply: { ...firstWork, body: 'Synthetic public completion', mentions: [b] } }
    const req = new Request('http://localhost:3110/worker', { method: 'POST', body: JSON.stringify(command) })
    const completed = httpOrigin ? await fetch(`${httpOrigin}/mikka/v1/devices/${device}/group-reviews`, { method: 'POST', headers: { authorization: `Bearer ${deviceBearer}`, 'content-type': 'application/json' }, body: await req.text() }) : await handleGroupWorkerRequest(req, device, { pool, directory, authenticate: async () => ({ userId: owner }) })
    assert.equal(completed.status, 200)
    const replyWork = (await q('SELECT * FROM conversation_work WHERE "triggerMessageId"=$1 AND "agentId"=$2', [firstWork.triggerMessageId, b])).rows[0]
    await dispatchReviewWork(pool, directory, groupMailboxAdapter(pool), replyWork.id)
    const claim = await claimGroupReview(pool, directory, owner, device, replyWork.id)
    assert.equal(claim.status, 'claimed')
    const response = await send({ workId: replyWork.id, triggerMessageId: firstWork.triggerMessageId, claimEpoch: claim.claimEpoch! }, created.input.exchangeId, { toAgentId: a, body: 'Synthetic Agent B reply' })
    assert.equal(response.status, 200)
    const read = (await link(created.input.exchangeId)).body as any
    assert.deepEqual(read.messages.map((m: any) => m.senderName), ['Exchange B', 'Exchange A'])
    assert.equal((await send(firstWork, created.input.exchangeId)).status, 409)
  })
  await check('queued revoke fences concurrent read and append after its commit', async () => {
    const raceGroup = await makeGroup(), raceWork = await makeWork(raceGroup), created = await send(raceWork)
    assert.equal(created.status, 200)
    const blocker = await pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [raceGroup])
    const revoke = link(created.input.exchangeId, { userId: owner, method: 'DELETE' })
    async function waiting(count: number) {
      for (let i = 0; i < 100; i++) {
        const rows = await q(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'SELECT * FROM conversations WHERE id=%' OR query LIKE 'SELECT id FROM conversations WHERE id=%')`)
        if ((rows.rowCount ?? 0) >= count) return true
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return false
    }
    let read: ReturnType<typeof link> | undefined, append: ReturnType<typeof send> | undefined
    try {
      assert.equal(await waiting(1), true, 'revoke is first waiting on the source lock')
      read = link(created.input.exchangeId)
      append = send(raceWork, created.input.exchangeId)
      assert.equal(await waiting(3), true, 'revoke/read/append really wait together')
    } finally { await blocker.query('COMMIT'); blocker.release() }
    assert.equal((await revoke).status, 200)
    assert.equal((await read!).status, 404)
    assert.equal((await append!).status, 404)
    assert.equal((await q('SELECT count(*) FROM conversation_exchange_messages WHERE "linkId"=$1', [created.input.exchangeId])).rows[0].count, '1')
  })
  await check('expired run cannot append or mint a link', async () => {
    const expiryGroup = await makeGroup(), expiryWork = await makeWork(expiryGroup)
    await q(`UPDATE agent_runs SET "leaseExpiresAt"=now()-interval '1 second' WHERE id=$1`, [expiryWork.workId])
    assert.equal((await send(expiryWork)).status, 409)
    assert.equal((await q('SELECT 1 FROM conversation_exchange_messages WHERE "workId"=$1', [expiryWork.workId])).rowCount, 0)
  })
  await check('Agent grant revocation invalidates the old link even after regrant', async () => {
    const fresh = await send(work)
    assert.equal(fresh.status, 200)
    await group({ id: g, resource: 'members', method: 'DELETE', body: JSON.stringify({ memberType: 'agent', memberId: b }) })
    assert.equal((await link(fresh.input.exchangeId)).status, 404)
    await group({ id: g, resource: 'members', method: 'POST', body: JSON.stringify({ memberType: 'agent', memberId: b }) })
    assert.equal((await link(fresh.input.exchangeId)).status, 404)
  })
  completed = true
} finally {
  if (recordingPage) await recordingPage.screenshot({ path: `${process.env.EXCHANGE_RECORDING_DIR}/acceptance.png`, fullPage: true })
  await recordingContext?.close()
  await recordingBrowser?.close()
  await writeFile(process.env.EXCHANGE_EVIDENCE_PATH ?? '/tmp/110-exchange-evidence.json', JSON.stringify({ sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), startedAt, finishedAt: new Date().toISOString(), completed, expectedChecks: 15, fixture: suffix, transport: httpOrigin ? 'actual-next-http' : 'actual-handlers', observations: evidence, retained: true }, null, 2))
  await pool.end()
}

}
main().catch(error => { console.error(error); process.exitCode = 1 })
