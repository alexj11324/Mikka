import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { tokenWorkspace } from '../lib/tokens/principal'
import { dbUrl, seedBot, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { personalMessage, sendFailureState, submissionBody, unsettled } from '../apps/mobile/lib/outbox'
import { mobileMessages } from '../apps/mobile/lib/messages'

mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => Object.assign((code: string) => code, { has: () => true }) } })

test('mobile chat response-loss retries use the real immutable submission ledger', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const ownerId = await seedUser(pool, 'mobile-outbox')
  const workspace = await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }])
  const botId = await seedBot(pool, workspace.id, ownerId)
  const principal: { id: string; name: string; email: string; [tokenWorkspace]?: string } = { id: ownerId, name: 'Fixture', email: `${ownerId}@example.invalid` }
  const callbacks: (() => unknown)[] = []
  let actionHeaders = new Headers()
  mock.module('next/server', { namedExports: { NextResponse: { json: (body: unknown, options?: ResponseInit) => Response.json(body, options) }, after: (callback: () => unknown) => callbacks.push(callback) } })
  mock.module('next/headers', { namedExports: { headers: async () => actionHeaders, cookies: async () => ({ get: (name: string) => name === 'mikka-workspace' ? { value: workspace.id } : undefined }) } })
  mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => ({ user: principal, session: { id: 'fixture-session' } }) } } } })
  mock.module(new URL('../lib/mobile-api.ts', import.meta.url).href, { namedExports: {
    json: (body: unknown, status = 200) => Response.json(body, { status }), mobileUser: async () => principal,
    writeAllowed: () => true, unauthorized: () => Response.json({ error: 'authRequired' }, { status: 401 }), forbiddenOrigin: () => Response.json({ error: 'originRejected' }, { status: 403 }),
  } })
  mock.module(new URL('../lib/coordinator/wake.ts', import.meta.url).href, { namedExports: { coordinatorEnabled: () => true, wakeCoordinator: async () => { throw Error('no model invocation in ledger tests') } } })
  const { POST } = await import('../app/api/mobile/chat/route')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => {
    await pool.query('DELETE FROM coordinator_events WHERE "userId"=$1', [ownerId])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const count = async (submissionText: string) => Number((await pool.query('SELECT count(*) AS n FROM coordinator_events WHERE "userId"=$1 AND "botId"=$2 AND payload->>\'text\'=$3', [ownerId, botId, submissionText])).rows[0].n)
  const post = async (body: unknown) => {
    actionHeaders = new Headers(principal[tokenWorkspace] ? { authorization: 'Bearer fixture' } : { cookie: 'fixture-session=1' })
    return POST(new Request('http://127.0.0.1/api/mobile/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  }
  for (const token of [false, true]) await t.test(`${token ? 'PAT' : 'session'}: a committed request with a lost response is recorded once on retry`, async () => {
    if (token) principal[tokenWorkspace] = workspace.id; else delete principal[tokenWorkspace]
    const text = `accepted-but-response-lost-${randomUUID()}`, submissionId = randomUUID()
    const images = [{ uri: 'file:///fixture.jpg', dataUrl: 'data:image/jpeg;base64,/9j/' }]
    const original = personalMessage(submissionId, text, images, { botId, chatKey: botId, context: 1 })
    const body = submissionBody(original)
    const committed = await post(body)
    assert.equal(committed.status, 202)
    // The server committed, but the phone lost the receipt. A retry carries the exact same identity.
    assert.equal(await count(text), 1)
    assert.equal(sendFailureState(new Error('response lost after database commit')), 'unconfirmed')
    const retry = unsettled([{ ...original, phase: 'failed', error: mobileMessages.Coordinator.sendUncertain }], text, images, botId, 1)!
    assert.equal(retry.phase, 'failed')
    assert.equal(retry.error, mobileMessages.Coordinator.sendUncertain)
    assert.deepEqual(submissionBody(retry), body)
    assert.equal(retry.submissionId, submissionId)
    const retried = await post(submissionBody(retry))
    assert.equal(retried.status, 202)
    assert.equal(await count(text), 1, 'retry must not create a second user event or logical turn')
    const [event] = (await pool.query('SELECT "dedupeKey" FROM coordinator_events WHERE "userId"=$1 AND payload->>\'text\'=$2', [ownerId, text])).rows
    assert.match(event.dedupeKey, /^personal_submission:v1:/)
    const replies = await Promise.all(Array.from({ length: 5 }, () => post(body)))
    assert.ok(replies.every(response => response.status === 202))
    assert.equal(await count(text), 1, 'concurrent replays also converge at the PostgreSQL unique constraint')
    assert.equal((await post({ ...body, text: 'changed body' })).status, token ? 409 : 400)
    assert.equal(await count('changed body'), 0)
  })
  await t.test('invalid ids are rejected before writing and new intentional sends get independent identities', async () => {
    delete principal[tokenWorkspace]
    assert.equal((await post({ text: 'invalid', botId, submissionId: 'not-a-uuid' })).status, 400)
    assert.equal(await count('invalid'), 0)
    const text = `separate-sends-${randomUUID()}`
    assert.equal((await post({ text, botId, submissionId: randomUUID() })).status, 202)
    assert.equal((await post({ text, botId, submissionId: randomUUID() })).status, 202)
    assert.equal(await count(text), 2)
  })
})
