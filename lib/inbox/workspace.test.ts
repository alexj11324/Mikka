import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { enterprisePrincipal, type EnterprisePrincipal } from '../enterprise/principal'
import { tokenWorkspace } from '../tokens/principal'
import { ActionFailureError } from '../action-error'
import { createInboxGuard } from './workspace'
import { InboxStore } from './store'
import { handleInbox } from './http'
import { InboxRequestError, readInboxPage, submitInboxCommand } from './client'

test('inbox reads and commands preserve the original session and machine provenance through canonical admission', async () => {
  const workspaceId = randomUUID(), url = 'https://app.invalid/api/inbox'
  const noDatabase = new Proxy({}, { get() { assert.fail('canonical refusal must happen before reading or writing inbox data') } }) as never
  const principals: EnterprisePrincipal[] = [
    { kind: 'session', sessionId: 'session-fixture' },
    { kind: 'pat', tokenId: 'pat-fixture', workspaceId },
    { kind: 'delegation', credentialId: 'delegated-fixture', credentialKind: 'oauth', workspaceId },
  ]
  for (const principal of principals) {
    const user = { id: 'owner', [enterprisePrincipal]: principal, ...(principal.kind === 'session' ? {} : { [tokenWorkspace]: workspaceId }) }
    let admissions = 0
    const guard = createInboxGuard(async (reader, selected) => {
      assert.equal(reader, user, 'the authenticated reader must not be reduced to an owner id or reconstructed from request input')
      assert.equal(selected, workspaceId)
      admissions++
      throw new ActionFailureError('workspaceAccessDenied')
    })
    const store = new InboxStore(noDatabase, guard, noDatabase, noDatabase)
    const read = await handleInbox(new Request(`${url}?workspaceId=${workspaceId}`), user, store)
    assert.equal(read.status, 403)
    assert.deepEqual(await read.json(), { error: 'workspaceAccessDenied' })
    const write = await handleInbox(new Request(url, { method: 'POST', headers: { origin: 'https://app.invalid' },
      body: JSON.stringify({ workspaceId, type: 'task', id: randomUUID(), action: 'reopen' }) }), user, store)
    assert.equal(write.status, 403)
    assert.equal(admissions, 2, 'each operation rechecks its original proof')
    const other = await handleInbox(new Request(`${url}?workspaceId=${randomUUID()}`), { ...user, [tokenWorkspace]: workspaceId }, store)
    assert.equal(other.status, 403)
    assert.equal(admissions, 2, 'a pinned token cannot ask the admission boundary for another tenant')
  }
})

test('inbox admission does not disguise infrastructure errors or release the lease before source work ends', async () => {
  const original = new Error('database fixture unavailable'), workspaceId = randomUUID()
  const refused = createInboxGuard(async () => { throw original })
  await assert.rejects(refused('owner', workspaceId, async () => true), error => error === original)
  let held = false
  const guard = createInboxGuard(async (_reader, id, work) => {
    held = true
    try { return await work({ id, kind: 'team' }, undefined as never) } finally { held = false }
  })
  assert.equal(await guard('owner', workspaceId, async scope => { await Promise.resolve(); assert.equal(held, true); assert.equal(scope.personal, false); return 'committed' }), 'committed')
  assert.equal(held, false)
})

test('the official Inbox reads scoped pages and preserves the opaque cursor', async t => {
  const workspaceId = randomUUID()
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string) => {
    const target = new URL(url, 'https://app.invalid')
    assert.equal(target.searchParams.get('workspaceId'), workspaceId)
    assert.equal(target.searchParams.get('tab'), 'done')
    assert.equal(target.searchParams.get('cursor'), 'second/page+==')
    return Response.json({ items: [], nextCursor: null, historySince: '2026-11-01T00:00:00Z' })
  })
  assert.deepEqual((await readInboxPage(workspaceId, 'done', 'second/page+==', 0)).items, [])
  assert.equal(fetch.mock.callCount(), 1)
})

test('official writes accept only the server receipt including an idempotent replay', async t => {
  const body = { workspaceId: randomUUID(), type: 'suggestion', id: randomUUID(), action: 'reject' } as const
  let response = Response.json({ changed: false })
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)), body)
    return response
  })
  assert.deepEqual(await submitInboxCommand(body, 0), { changed: false })
  response = Response.json({})
  await assert.rejects(submitInboxCommand(body, 0), error => error instanceof InboxRequestError && error.code === 'decisionUnconfirmed')
  for (const status of [401, 403, 404, 409, 422, 429, 503]) {
    response = Response.json({ error: 'inboxReadRefused' }, { status })
    await assert.rejects(submitInboxCommand(body, 0), error => error instanceof InboxRequestError && error.status === status && error.code === 'inboxReadRefused')
  }
  const sent = fetch.mock.callCount()
  await assert.rejects(submitInboxCommand(body, 1), error => error instanceof InboxRequestError && error.code === 'decisionUnavailable')
  assert.equal(fetch.mock.callCount(), sent)
})
