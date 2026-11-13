import assert from 'node:assert/strict'
import test from 'node:test'
import {internalEveAuthorization,internalEveScope,internalEveHeaders,internalEveRequestScope} from './auth'
import {conversationAddress,scopeAuth,scopeFromAuth} from './scope'

test('host eve credentials bind exact owner, Bot, Workspace and surface with expiry',()=>{
  const prior=process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET='fixture-host-key-with-more-than-thirty-two-characters'
  try {
    const scope={ownerId:'alice',botId:'11111111-1111-4111-8111-111111111111',workspaceId:'22222222-2222-4222-8222-222222222222',surface:'web' as const}
    const header=internalEveAuthorization(scope,1000)
    assert.deepEqual(internalEveScope(header,1001),scope)
    assert.equal(internalEveScope(header,61000),null)
    assert.equal(internalEveScope(header.replace('mev_','mev_x'),1001),null)
    assert.equal(internalEveScope(header+'x',1001),null)
    assert.deepEqual(scopeFromAuth(scopeAuth(scope)),scope)
    assert.notEqual(conversationAddress(scope),conversationAddress({...scope,ownerId:'bob'}))
    assert.notEqual(conversationAddress(scope),conversationAddress({...scope,surface:'slack'}))
    assert.throws(()=>scopeFromAuth({...scopeAuth(scope),authenticator:'unknown'}),/authRequired/)
  } finally {if(prior===undefined)delete process.env.BETTER_AUTH_SECRET;else process.env.BETTER_AUTH_SECRET=prior}
})


test('Cloudflare accepts only binding provenance and rejects legacy bearer, cookies and caller scope', t => {
  t.mock.property(process, 'env', { ...process.env, MIKKA_API_INGRESS: 'cloudflare', BETTER_AUTH_SECRET: 'fixture-host-key-with-more-than-thirty-two-characters' })
  const scope = {ownerId:'owner',botId:'11111111-1111-4111-8111-111111111111',workspaceId:'22222222-2222-4222-8222-222222222222',surface:'web' as const}
  const headers = internalEveHeaders(scope)
  assert.equal(headers.authorization, undefined)
  const request = (headers: Record<string,string>) => new Request('https://app.example/mikka/api/internal/eve/tools', {headers})
  for (const denied of [{}, headers, {authorization:internalEveAuthorization(scope)}, {'x-mikka-eve-binding-scope':'{bad'}, {'x-mikka-eve-binding-scope':'null'}, {cookie:'better-auth.session_token=fixture'}]) {
    assert.equal(internalEveRequestScope(request(denied)), null)
  }
  assert.deepEqual(internalEveRequestScope(request({'x-mikka-eve-binding-scope':JSON.stringify(scope)})), scope)
})
