import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceError } from '../workspace-error'
import { approveSecretDelivery } from './delivery'
import { createSecretDeliveryHandler, SECRET_DELIVERY_MAX_BODY_BYTES } from './delivery-http'
import type { UserSecretView } from './user-store'
import type { WorkspaceSecretView } from './store'

const id = '10000000-0000-4000-8000-000000000001'
const workspaceId = '20000000-0000-4000-8000-000000000001'
const origin = 'https://mikka.example'
const signedHuman = `Bearer signed.human.${'a'.repeat(48)}`
const actor = { id: 'authenticated-user', name: 'Human' }
const personal: UserSecretView = { id, name: 'SERVICE_KEY', kind: 'secret', note: '', updatedAt: '2026-11-08T12:00:00.000Z', delivery: { mode: 'protected' } }
const workspace: WorkspaceSecretView = { ...personal, scopeType: 'repository', scopeRef: 'owner/repository', updatedBy: 'Human' }
type Dependencies = Parameters<typeof createSecretDeliveryHandler>[0]

function fixture(overrides: Partial<Dependencies> = {}) {
  const sessions: Array<{ headers: Headers; query: unknown }> = [], calls: Array<{ operation: string; args: unknown[] }> = []
  const handle = createSecretDeliveryHandler({
    async getSession(input) {
      sessions.push(input)
      return input.headers.get('authorization') === signedHuman || !input.headers.has('authorization') && input.headers.get('cookie') === 'session=valid'
        ? { user: actor, session: { id: 'human-session' } } : null
    },
    async listPersonal(...args) { calls.push({ operation: 'listPersonal', args }); return [personal, { ...personal, id: 'env', name: 'REGION', kind: 'env' }] },
    async listWorkspace(...args) { calls.push({ operation: 'listWorkspace', args }); return [workspace] },
    async replacePersonal(...args) {
      calls.push({ operation: 'replacePersonal', args })
      return { ...personal, delivery: approveSecretDelivery(args[1].delivery, args[0].id, new Date('2026-11-08T13:00:00.000Z')) }
    },
    async replaceWorkspace(...args) {
      calls.push({ operation: 'replaceWorkspace', args })
      return { ...workspace, delivery: approveSecretDelivery(args[2].delivery, args[0].id, new Date('2026-11-08T13:00:00.000Z')) }
    },
    ...overrides,
  })
  return { sessions, calls, handle }
}
const read = (query = 'scope=personal', headers: Record<string, string> = { cookie: 'session=valid' }) => new Request(`${origin}/api/secrets/delivery?${query}`, { headers })
const patch = (body: unknown, headers: Record<string, string> = {}) => new Request(`${origin}/api/secrets/delivery`, {
  method: 'PATCH', headers: { cookie: 'session=valid', origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})
const direct = { mode: 'direct', exposeToAgent: true } as const

test('GET selects one authorized scope, requests a fresh session and returns only explicit secret metadata', async () => {
  const f = fixture({ listPersonal: async () => [{ ...personal, value: 'synthetic-plaintext', ciphertext: 'synthetic-cipher', iv: 'nonce' } as UserSecretView] })
  const response = await f.handle(read())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(f.sessions[0].query, { disableCookieCache: true })
  const body = await response.json()
  assert.deepEqual(body, { scope: 'personal', secrets: [personal] })
  assert.ok(!JSON.stringify(body).includes('synthetic'))
  const g = fixture()
  const workspaceResponse = await g.handle(read(`scope=workspace&workspaceId=${workspaceId}`))
  assert.deepEqual(await workspaceResponse.json(), { scope: 'workspace', workspaceId, secrets: [workspace] })
  assert.deepEqual(g.calls, [{ operation: 'listWorkspace', args: [actor, workspaceId] }])
  assert.equal((await (await g.handle(read())).json()).secrets.length, 1, 'ordinary env rows are excluded')
})

test('GET rejects ambiguous, foreign and unknown query scope instead of falling back to personal storage', async () => {
  const f = fixture()
  for (const query of ['', 'scope=other', `scope=personal&workspaceId=${workspaceId}`, 'scope=workspace', 'scope=workspace&workspaceId=invalid', 'scope=personal&scope=workspace', 'scope=personal&ownerId=forged'])
    assert.equal((await f.handle(read(query))).status, 400, query)
  assert.equal(f.calls.length, 0)
})

test('delegated and machine tokens cannot be rescued by a valid human cookie', async () => {
  const f = fixture()
  for (const authorization of [`Bearer mkp_${'a'.repeat(43)}`, `Bearer MKP_${'a'.repeat(43)}`, `Bearer mka_${'a'.repeat(43)}`, `Bearer mkr_${'a'.repeat(43)}`, `Bearer ${'d'.repeat(64)}`, 'Bearer invalid', 'Basic dXNlcjpwYXNz']) {
    const response = await f.handle(read('scope=personal', { cookie: 'session=valid', authorization }))
    assert.equal(response.status, 401, authorization.slice(0, 15))
  }
  assert.ok(f.sessions.every(input => !input.headers.has('cookie')))
  assert.equal(f.calls.length, 0)
  assert.equal((await f.handle(read('scope=personal', {}))).status, 401)
  assert.equal((await fixture({ getSession: async () => ({ user: actor, session: { id: 'pat:delegated' }, tokenWorkspaceId: workspaceId }) }).handle(read())).status, 401)
})

test('signed native human sessions remain valid and never borrow browser cookie authority', async () => {
  const f = fixture()
  const response = await f.handle(read('scope=personal', { authorization: signedHuman, cookie: 'unrelated=invalid' }))
  assert.equal(response.status, 200)
  assert.equal(f.sessions[0].headers.has('cookie'), false)
  assert.deepEqual(f.sessions[0].query, { disableCookieCache: true })
})

test('cross-origin browser reads and writes are rejected before any authentication or store work', async () => {
  const f = fixture()
  const attacks: Array<Record<string, string>> = [
    { cookie: 'session=valid', origin: 'https://evil.example' },
    { cookie: 'session=valid', origin: 'null' },
    { cookie: 'session=valid', 'sec-fetch-site': 'cross-site' },
    { cookie: 'session=valid', 'sec-fetch-site': 'same-site' },
  ]
  for (const headers of attacks) assert.equal((await f.handle(read('scope=personal', headers))).status, 403)
  assert.equal((await f.handle(patch({ id, delivery: direct }, { origin: 'https://evil.example' }))).status, 403)
  const missingOrigin = patch({ id, delivery: direct }); missingOrigin.headers.delete('origin')
  assert.equal((await f.handle(missingOrigin)).status, 403)
  assert.equal(f.sessions.length, 0); assert.equal(f.calls.length, 0)
})

test('PATCH delegates only id and approved delivery input to the authenticated owner and stamps direct consent server-side', async () => {
  const f = fixture()
  const response = await f.handle(patch({ id, delivery: direct }))
  assert.equal(response.status, 200)
  assert.deepEqual(f.calls, [{ operation: 'replacePersonal', args: [actor, { id, delivery: direct }] }])
  const value = await response.json()
  assert.deepEqual(value.secret.delivery, { ...direct, approvedBy: actor.id, approvedAt: '2026-11-08T13:00:00.000Z' })
  assert.equal(value.scope, 'personal')
  assert.equal(f.sessions.length, 1)
})

test('workspace PATCH keeps the workspace selector and original request available for existing authorization and transactional audit', async () => {
  const f = fixture()
  const delivery = { mode: 'protected', http: { origin: 'https://api.example.com/', header: 'x-api-key', prefix: '', rules: [{ method: 'GET', path: '/v1/widgets', match: 'exact' }] } }
  const request = patch({ id, workspaceId, delivery })
  const response = await f.handle(request)
  assert.equal(response.status, 200)
  const canonical = { ...delivery, http: { ...delivery.http, origin: 'https://api.example.com' } }
  assert.deepEqual(f.calls, [{ operation: 'replaceWorkspace', args: [actor, workspaceId, { id, delivery: canonical }, request] }])
  const value = await response.json()
  assert.equal(value.workspaceId, workspaceId); assert.deepEqual(value.secret.delivery, canonical)
})

test('PATCH rejects raw values, scope moves, forged approval fields and missing direct consent', async () => {
  const f = fixture()
  for (const body of [
    { id, delivery: direct, value: 'do-not-write' }, { id, delivery: direct, ownerId: 'forged' }, { id, delivery: direct, note: 'do-not-edit' },
    { id, delivery: direct, scope: { type: 'workspace' } }, { id, workspaceId: 'invalid', delivery: direct },
    { id, delivery: { mode: 'direct' } }, { id, delivery: { mode: 'direct', exposeToAgent: false } },
    { id, delivery: { ...direct, approvedBy: 'forged-owner' } }, { id, delivery: { ...direct, approvedAt: '2026-01-01T00:00:00.000Z' } },
    { id, delivery: { mode: 'protected', http: { origin: 'http://localhost', header: 'authorization', prefix: '', rules: [] } } },
  ]) assert.equal((await f.handle(patch(body))).status, 400)
  const wrongContentType = patch({ id, delivery: direct }, { 'content-type': 'text/plain' })
  assert.equal((await f.handle(wrongContentType)).status, 400)
  assert.equal(f.calls.length, 0)
})

test('JSON errors and both declared and streamed body limits fail without changing a secret', async () => {
  const f = fixture()
  const huge = patch({ id, delivery: direct, padding: 'x'.repeat(SECRET_DELIVERY_MAX_BODY_BYTES) })
  assert.equal((await f.handle(huge)).status, 413)
  const dishonest = patch({ id, delivery: direct }, { 'content-length': String(SECRET_DELIVERY_MAX_BODY_BYTES + 1) })
  assert.equal((await f.handle(dishonest)).status, 413)
  const malformed = new Request(`${origin}/api/secrets/delivery`, { method: 'PATCH', headers: { cookie: 'session=valid', origin, 'content-type': 'application/json' }, body: '{invalid' })
  assert.equal((await f.handle(malformed)).status, 400)
  assert.equal(f.calls.length, 0)
})

test('membership, per-secret edit policy and missing rows keep the stores denial semantics and unknown errors disclose nothing', async () => {
  for (const [code, status] of [['workspaceAccessDenied', 403], ['secretPermissionDenied', 403], ['secretNotFound', 404], ['validationGeneric', 400], ['secretsUnavailable', 503]] as const) {
    const f = fixture({ replaceWorkspace: async () => { throw new WorkspaceError(code) } })
    const response = await f.handle(patch({ id, workspaceId, delivery: direct }))
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { error: code })
    assert.equal(f.calls.length, 0, 'a workspace denial never retries in personal storage')
  }
  const f = fixture({ replacePersonal: async () => { throw new Error('synthetic-secret-in-database-error') } })
  const response = await f.handle(patch({ id, delivery: direct }))
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'secretsUnavailable' })
})
