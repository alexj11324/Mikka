import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

// Only normal Mikka OAuth HTTP endpoints are used. The caller supplies its
// already attested/leased owner request function and secret-audit recorder.
export async function authorizeMcpSession(owner, environment, recordSecrets) {
  const callback = 'http://127.0.0.1:45123/callback'
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  const registered = await owner.request('/api/auth/oauth2/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Older runtime acceptance', application_type: 'native', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: 'mikka' }),
  })
  assert.equal(registered.status, 201, 'Normal OAuth public-client registration must succeed')
  const registration = await registered.json()
  assert.ok(typeof registration.client_id === 'string')
  const query = new URLSearchParams({ response_type: 'code', client_id: registration.client_id, redirect_uri: callback, scope: 'mikka', state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource: `${environment.origin}/mikka/api/mcp` })
  const authorized = await owner.request(`/api/auth/oauth2/authorize?${query}`)
  assert.ok([200, 302, 303, 307].includes(authorized.status), 'Normal OAuth authorization must return its consent destination')
  const location = authorized.headers.get('location') ?? (authorized.status === 200 ? (await authorized.json()).url : undefined)
  assert.ok(typeof location === 'string')
  const consent = new URL(location, environment.origin)
  assert.equal(consent.origin, environment.origin)
  assert.ok(consent.pathname.endsWith('/oauth/consent'))
  // The same normal session/cookie jar retains the provider's signed state.
  const accepted = await owner.request('/api/auth/oauth2/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept: true, oauth_query: consent.searchParams.toString() }) })
  assert.equal(accepted.status, 200)
  const result = await accepted.json()
  const returned = new URL(result.url)
  assert.equal(`${returned.origin}${returned.pathname}`, callback)
  assert.equal(returned.searchParams.get('state'), state)
  const code = returned.searchParams.get('code')
  assert.ok(code)
  await recordSecrets([verifier, code])
  const exchanged = await fetch(`${environment.origin}/mikka/api/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registration.client_id, redirect_uri: callback, code_verifier: verifier, code, resource: `${environment.origin}/mikka/api/mcp` }), redirect: 'error', signal: AbortSignal.timeout(30_000) })
  assert.equal(exchanged.status, 200, 'Normal PKCE token exchange must succeed')
  const token = await exchanged.json()
  assert.ok(typeof token.access_token === 'string' && token.access_token.startsWith('mka_'))
  await recordSecrets([token.access_token])
  let session, protocol = '2025-06-18', sequence = 0
  async function rpc(method, params, notification = false) {
    const id = notification ? undefined : ++sequence
    const response = await fetch(`${environment.origin}/mikka/api/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol, ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }), redirect: 'error', signal: AbortSignal.timeout(30_000) })
    assert.ok(response.ok, 'Authenticated MCP HTTP request must succeed')
    session = response.headers.get('mcp-session-id') ?? session
    if (notification || response.status === 202) { await response.body?.cancel(); return }
    const text = await response.text()
    const message = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(value => value.id === id)
    assert.ok(message && !message.error, 'MCP must return the actual successful JSON-RPC result')
    return message.result
  }
  const initialized = await rpc('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'older-runtime-acceptance', version: '1' } })
  protocol = initialized.protocolVersion
  await rpc('notifications/initialized', undefined, true)
  return { clientId: registration.client_id, rpc, async call(name, args = {}) { const result = await rpc('tools/call', { name, arguments: args }); const text = result.content?.find(block => block.type === 'text')?.text; if(result.isError){let code='tool_refused';try{const value=JSON.parse(text);if(typeof value.error==='string')code=value.error}catch{}throw new Error('MCP '+name+' refused: '+code)} return text ? JSON.parse(text) : result } }
}
