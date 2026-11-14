import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import test from 'node:test'
import {registryCredentials} from './cloudflare-registry-credentials.mjs'

const account = 'd8f6630c7869111a5139bc5ed4d24ace'
const env = {CLOUDFLARE_API_TOKEN:randomBytes(32).toString('hex')}

test('Registry credentials use the existing Cloudflare identity and bounded permissions for each phase', async t => {
  const credential = {username:'v1',password:randomBytes(32).toString('base64url')}
  const calls = []
  t.mock.method(globalThis,'fetch',async (url,options) => {
    assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/' + account + '/containers/registries/registry.cloudflare.com/credentials')
    assert.equal(options.method,'POST')
    assert.equal(options.redirect,'error')
    assert.equal(options.headers.authorization,'Bearer ' + env.CLOUDFLARE_API_TOKEN)
    calls.push(JSON.parse(options.body))
    return Response.json({success:true,result:{account_id:account,registry_host:'registry.cloudflare.com',...credential}})
  })
  assert.deepEqual(await registryCredentials('read',env),credential)
  assert.deepEqual(await registryCredentials('publish',env),credential)
  assert.deepEqual(calls,[{expiration_minutes:15,permissions:['pull']},{expiration_minutes:15,permissions:['push','pull']}])
})

test('provider denial and a foreign Registry response cannot fall back to a stored password', async t => {
  let status = 403
  let result = {account_id:account,registry_host:'registry.cloudflare.com',username:'v1',password:randomBytes(32).toString('hex')}
  t.mock.method(globalThis,'fetch',async () => status === 200 ? Response.json({success:true,result}) : new Response('private response',{status}))
  for (status of [401,403]) await assert.rejects(registryCredentials('read',env),{message:'CF_REGISTRY_AUTHORITY_REQUIRED'})
  status = 200
  for (const patch of [{account_id:'other'},{registry_host:'other.example'},{password:'multiline\nvalue'}]) {
    const prior = result
    result = {...result,...patch}
    await assert.rejects(registryCredentials('read',env),{name:'AssertionError'})
    result = prior
  }
})
