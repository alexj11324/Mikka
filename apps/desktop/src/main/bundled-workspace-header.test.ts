import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundledProtocol } from './bundled-protocol'
import { RENDERER_URL } from './bundled-policy'

const workspace = '6f2c1d8e-3b4a-4c5d-9e8f-0a1b2c3d4e5f'

async function forwarded(value: string | undefined) {
  let seen: Headers | undefined
  const serve = bundledProtocol('/unused', { request: async (_path, init) => { seen = new Headers(init?.headers); return Response.json({ ok: true }) } })
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-mikka-desktop-protocol': '1' }
  if (value !== undefined) headers['x-mikka-workspace-id'] = value
  const response = await serve(new Request(`${RENDERER_URL}/api/desktop/rpc`, { method: 'POST', headers, body: '{}' }))
  assert.equal(response.status, 200)
  return seen!.get('x-mikka-workspace-id')
}

test('a per-request Workspace selection crosses the bundled protocol (#1661)', async () => {
  assert.equal(await forwarded(workspace), workspace)
})

test('a missing or malformed Workspace selection does not cross', async () => {
  assert.equal(await forwarded(undefined), null)
  assert.equal(await forwarded('not-a-workspace'), null)
  assert.equal(await forwarded(`${workspace}, ${workspace}`), null)
})
