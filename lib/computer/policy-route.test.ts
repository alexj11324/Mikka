import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createComputerPolicyHandler } from './policy-route'

const workspace = randomUUID()
const endpoint = 'https://mikka.example/api/workspaces/policy'
const request = (body: string, origin = 'https://mikka.example') => new Request(endpoint, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body })

test('only workspace admins may change policy, using an exact same-origin request', async () => {
  let writes = 0
  let role: 'admin' | 'member' | 'absent' = 'member'
  const handler = createComputerPolicyHandler({ enabled: () => true,
    withMember: async (_request, _workspace, _admin, operation) => role === 'absent' ? null : operation(role === 'admin'),
    store: { policy: async () => 'allow', setPolicy: async (_, permission) => { writes++; return { permission } } },
  })
  let response = await handler(new Request(endpoint), workspace)
  assert.deepEqual(await response.json(), { enabled: true, permission: 'allow', canEdit: false })
  assert.equal((await handler(request('{"permission":"deny"}'), workspace)).status, 403)
  role = 'absent'
  assert.equal((await handler(new Request(endpoint), workspace)).status, 403)
  role = 'admin'
  assert.equal((await handler(request('{"permission":"deny"}', 'https://other.example'), workspace)).status, 403)
  assert.equal((await handler(request('{"permission":"unknown"}'), workspace)).status, 400)
  // Per-step approval was retired on 2026-10-30; it is no longer a choice.
  assert.equal((await handler(request('{"permission":"ask"}'), workspace)).status, 400)
  assert.equal((await handler(request(JSON.stringify({ permission: 'deny', extra: 'x'.repeat(250) })), workspace)).status, 400)
  assert.equal(writes, 0)
  response = await handler(request('{"permission":"deny"}'), workspace)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { permission: 'deny' })
  assert.equal(writes, 1)
  response = await handler(request('{"permission":"allow"}'), workspace)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { permission: 'allow' })
  assert.equal(writes, 2)
})

test('disabled and failed backends cannot expose details or change settings', async () => {
  const fail = async () => { throw new Error('private provider details') }
  const disabled = createComputerPolicyHandler({ enabled: () => false, withMember: fail, store: { policy: fail, setPolicy: fail } })
  assert.deepEqual(await (await disabled(new Request(endpoint), workspace)).json(), { enabled: false })
  assert.equal((await disabled(request('{"permission":"deny"}'), workspace)).status, 503)
  const enabled = createComputerPolicyHandler({ enabled: () => true, withMember: async (_request, _workspace, _admin, operation) => operation(true), store: { policy: fail, setPolicy: fail } })
  const response = await enabled(request('{"permission":"deny"}'), workspace)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'Computer policy unavailable' })
})

test('policy writes complete inside the authorized membership operation', async () => {
  const events: string[] = []
  const handler = createComputerPolicyHandler({
    enabled: () => true,
    withMember: async (_request, id, admin, operation) => {
      assert.equal(id, workspace)
      assert.equal(admin, true)
      events.push('membership held')
      try { return await operation(true) }
      finally { events.push('membership released') }
    },
    store: {
      policy: async () => 'allow',
      setPolicy: async (_id, permission) => {
        await Promise.resolve()
        events.push('policy written')
        return { permission }
      },
    },
  })
  assert.equal((await handler(request('{"permission":"deny"}'), workspace)).status, 200)
  assert.deepEqual(events, ['membership held', 'policy written', 'membership released'])
})
