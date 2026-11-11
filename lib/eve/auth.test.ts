import assert from 'node:assert/strict'
import test from 'node:test'
import {internalEveAuthorization,internalEveScope} from './auth'
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
