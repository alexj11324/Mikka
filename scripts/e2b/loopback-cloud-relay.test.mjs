import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Agent, fetch } from 'undici'
import { startLoopbackCloudRelay } from './loopback-cloud-relay.mjs'

test('local cloud TLS relay keeps the actual claim policy, scopes MCP and refuses account paths', async t => {
  const deviceId = randomUUID(), runId = randomUUID(), issueId = randomUUID()
  const device = `orv_${'d'.repeat(43)}`, repoToken = 'g'.repeat(43), mcpToken = 'synthetic-mcp-token'.repeat(3)
  const requests = [], observations = []
  let relay, foreignIssuer = false
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.host, new URL(localOrigin).host)
    const body = []
    for await (const part of request) body.push(part)
    requests.push({ path: request.url, host: request.headers.host, forwardedHost: request.headers['x-forwarded-host'], protocol: request.headers['x-forwarded-proto'], authorization: request.headers.authorization })
    response.setHeader('set-cookie', 'must-not-leave=synthetic')
    if (request.url.endsWith('/claim')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ runId, issueId, policySnapshot: { payload: { issuer: foreignIssuer ? 'https://foreign.invalid/mikka' : `${relay.origin}/mikka` }, signature: 'unchanged-synthetic-signature' },
        mcp: { token: mcpToken, url: `${localOrigin}/mikka/api/mcp` },
        github: { endpoint: `${localOrigin}/mikka/api/runs/github-token`, repository: 'mikka-e2e/core-loop', branch: 'mikka/cloud-1' } }))
    } else { response.setHeader('content-type', 'application/json'); response.end('{}') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const localOrigin = `http://127.0.0.1:${server.address().port}`
  t.after(() => { server.closeAllConnections(); server.close() })
  relay = await startLoopbackCloudRelay({ localOrigin, repoToken, observe: item => observations.push(item) })
  t.after(() => relay.stop())
  const dispatcher = new Agent({ connect: { ca: relay.ca } })
  t.after(() => dispatcher.close())
  const send = async (path, token = device, options = {}) => {
    const result = await fetch(`${relay.origin}${path}`, { ...options, dispatcher, headers: { authorization: `Bearer ${token}`, ...options.headers } })
    return { status: result.status, headers: result.headers, text: await result.text() }
  }
  assert.equal((await send('/mikka/v1/probe')).status, 401)
  await relay.bindDevice(device, deviceId)
  await assert.rejects(relay.bindDevice(device, deviceId))
  const claimPath = `/mikka/v1/devices/${deviceId}/runs/${runId}/claim`
  const claim = await send(claimPath, device, { method: 'POST', headers: { 'x-forwarded-host': 'foreign.invalid', 'x-forwarded-proto': 'http' } })
  assert.equal(claim.status, 200)
  const context = JSON.parse(claim.text)
  assert.equal(context.policySnapshot.signature, 'unchanged-synthetic-signature')
  assert.equal(context.policySnapshot.payload.issuer, `${relay.origin}/mikka`)
  assert.equal(context.mcp.url, `${relay.origin}/mikka/api/mcp`)
  assert.equal(claim.headers.get('set-cookie'), null)
  assert.deepEqual(requests.at(-1), { path: claimPath, host: new URL(localOrigin).host, forwardedHost: undefined, protocol: undefined, authorization: `Bearer ${device}` })
  assert.equal((await send('/mikka/api/mcp', mcpToken, { method: 'POST' })).status, 200)
  assert.equal((await send('/mikka/api/mcp', mcpToken)).status, 401)
  assert.equal((await send('/mikka/api/mcp', device, { method: 'POST' })).status, 401)
  assert.equal((await send('/mikka/api/mcp?foreign=1', device, { method: 'POST' })).status, 502)
  assert.equal((await send('/mikka/api/auth/session')).status, 502)
  assert.equal((await send('/mikka/v1/probe', device, { headers: { cookie: 'forbidden=synthetic' } })).status, 401)
  const tokenPath = '/mikka/api/runs/github-token'
  assert.equal((await send(tokenPath, mcpToken, { method: 'POST', body: JSON.stringify({ issueId, repository: 'foreign/repository', branch: 'mikka/cloud-1' }) })).status, 403)
  assert.equal((await send(tokenPath, mcpToken, { method: 'POST', body: JSON.stringify({ issueId, repository: 'mikka-e2e/core-loop', branch: 'mikka/cloud-1' }) })).status, 200)
  foreignIssuer = true
  assert.equal((await send(claimPath, device, { method: 'POST' })).status, 502)
  assert.ok(observations.every(item => !JSON.stringify(item).includes(device) && !JSON.stringify(item).includes(mcpToken)))
  assert.equal((await send(`/mikka/v1/devices/${deviceId}/runs/${runId}/complete`, device, { method: 'POST' })).status, 200)
  assert.equal(relay.completed, true)
  assert.equal((await send('/mikka/api/mcp', mcpToken, { method: 'POST' })).status, 401)
})
