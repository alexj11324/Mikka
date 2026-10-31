import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelAdmissionHandler } from './http'

test('model policy HTTP boundary derives the principal and refuses scope injection, foreign origins and excess bytes', async () => {
  const workspaceId = '10000000-0000-4000-8000-000000000001'
  const saved: unknown[] = []
  const handle = createModelAdmissionHandler({ principal: async () => 'authenticated-owner', store: {
    async read(scope) { saved.push(scope); return { policy: null, revision: 'a'.repeat(64) } },
    async set(scope, expectedRevision, policy) { saved.push({ scope, expectedRevision, policy }); return { policy: null, revision: 'b'.repeat(64) } },
  } })
  const send = (body: unknown, origin = 'http://localhost') => handle(new Request('http://localhost/model-policy', {
    method: 'POST', headers: { origin }, body: JSON.stringify(body),
  }), workspaceId)
  const input = { expectedRevision: 'a'.repeat(64), policy: null }
  assert.equal((await send(input, 'https://foreign.example')).status, 403)
  assert.equal((await send({ ...input, ownerId: 'forged-owner' })).status, 400)
  assert.equal((await send({ ...input, padding: 'x'.repeat(17_000) })).status, 413)
  assert.equal(saved.length, 0)
  const response = await send(input)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(saved, [{ scope: { workspaceId, ownerId: 'authenticated-owner' }, ...input }])
})
