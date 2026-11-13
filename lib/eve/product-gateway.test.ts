import assert from 'node:assert/strict'
import test from 'node:test'
import { handleEveProductRequest, type EveProductGatewayServices } from './product-gateway'

const scope = { ownerId: 'owner', botId: 'b11e5145-bf3e-4a30-b7de-745c386813c4', workspaceId: '33a75a6c-5e29-4cd3-99d9-e45f8f836912', surface: 'web' as const }
const body = { operation: 'execute', sessionId: 'wrun_session', turnId: 'turn_1', executionId: '653d6418-3a58-417e-8aeb-0a56b8d46ac2', name: 'read_issue', input: { id: 'issue_1' }, callId: 'call_1' }
const request = (value: unknown) => new Request('https://app.example/mikka/api/internal/eve/tools', { method: 'POST', body: JSON.stringify(value) })

test('unauthenticated requests are refused before body parsing, session lookup or tool work', async () => {
  let touched = false
  const services: EveProductGatewayServices = { authorize: async () => null, assertSession: async () => { touched = true }, run: async () => { touched = true } }
  const response = await handleEveProductRequest(request(body), services)
  assert.equal(response.status, 401)
  assert.equal(touched, false)
})

test('an authenticated request still needs authorization to its persisted session before tool execution', async () => {
  let invoked = false
  const response = await handleEveProductRequest(request(body), {
    authorize: async () => scope,
    assertSession: async (actual, id) => { assert.deepEqual(actual, scope); assert.equal(id, body.sessionId); throw new Error('notFound') },
    run: async () => { invoked = true },
  })
  assert.equal(response.status, 404)
  assert.equal(invoked, false)
})

test('client fields cannot choose another owner, Workspace or schedule authority', async () => {
  for (const extra of [{ ownerId: 'other' }, { workspaceId: scope.workspaceId }, { sourceEventId: 'invented' }, { scheduledRead: { allowedActions: ['dispatch_run'] } }]) {
    const response = await handleEveProductRequest(request({ ...body, ...extra }), {
      authorize: async () => scope,
      assertSession: async () => { throw new Error('should not reach authorization') },
      run: async () => { throw new Error('should not run') },
    })
    assert.equal(response.status, 400)
  }
})

test('tool arguments and cancellation signal reach the authorized product service without another model loop', async () => {
  const req = request(body)
  const response = await handleEveProductRequest(req, {
    authorize: async () => scope, assertSession: async () => {},
    run: async (actual, input, signal) => {
      assert.deepEqual(actual, scope); assert.deepEqual(input, body); assert.equal(signal, req.signal)
      return { output: { title: 'The current issue' } }
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { output: { title: 'The current issue' } })
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
})

test('approval review and native resumption use separate strict host operations', async () => {
  const responder = { authenticator: 'mikka', principalType: 'user', principalId: scope.ownerId,
    attributes: { botId: scope.botId, workspaceId: scope.workspaceId, surface: scope.surface } }
  const seen: unknown[] = []
  const services: EveProductGatewayServices = { authorize: async () => scope, assertSession: async () => {}, run: async (_scope, input, _signal, request) => {
    assert.equal(request.headers.get('authorization'), 'Bearer trusted-service-fixture')
    seen.push(input)
    return input.operation === 'approval' ? { status: 'user-approval' } : { output: 'sent' }
  } }
  for (const value of [{ ...body, operation: 'approval' }, { ...body, approvalResponder: responder }]) {
    const req = request(value)
    req.headers.set('authorization', 'Bearer trusted-service-fixture')
    assert.equal((await handleEveProductRequest(req, services)).status, 200)
  }
  assert.equal(seen.length, 2)
  for (const value of [
    { ...body, operation: 'approval', approvalResponder: responder },
    { ...body, approvalResponder: { ...responder, getToken: 'model-chosen' } },
    { ...body, approvalResponder: { ...responder, attributes: { ...responder.attributes, sourceEventId: 'forged' } } },
  ]) assert.equal((await handleEveProductRequest(request(value), services)).status, 400)
  assert.equal(seen.length, 2)
})

test('native settlement is scoped and cannot supply its own event or schedule authority', async () => {
  const seen: unknown[] = []
  const services: EveProductGatewayServices = { authorize: async () => scope, assertSession: async () => {}, run: async (_scope, input) => { seen.push(input); return { ok: true } } }
  const finish = { operation: 'finish', sessionId: body.sessionId, turnId: body.turnId, outcome: 'completed', messages: [] }
  assert.equal((await handleEveProductRequest(request(finish), services)).status, 200)
  assert.equal((await handleEveProductRequest(request({ ...finish, sourceEventId: 'forged' }), services)).status, 400)
  assert.equal((await handleEveProductRequest(request({ ...finish, scheduledRead: { leaseToken: 'forged' } }), services)).status, 400)
  assert.equal((await handleEveProductRequest(request({ ...finish, outcome: 'invented' }), services)).status, 400)
  assert.equal(seen.length, 1)
})

test('malformed and oversized arguments fail before execution; raw provider failures never leave', async () => {
  const services: EveProductGatewayServices = { authorize: async () => scope, assertSession: async () => {}, run: async () => { throw new Error('provider body: private fixture token') } }
  const failed = await handleEveProductRequest(request(body), services)
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), { error: 'failed' })
  assert.equal((await handleEveProductRequest(request({ ...body, input: 'x'.repeat(512 * 1024) }), services)).status, 400)
  assert.equal((await handleEveProductRequest(new Request('https://app.example', { method: 'POST', body: '{bad' }), services)).status, 400)
})
