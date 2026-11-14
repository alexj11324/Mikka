import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import type { ApprovalConfiguration } from 'eve/tools/approval'
import { createProductTool } from './product-tool'
import { productRpc, type ProductCatalogueEntry, type ProductOperation } from './product-rpc'
import { internalEveScope } from './auth'
import { scopeAuth, type EveScope } from './scope'

const scope = {ownerId:'owner',botId:'10000000-0000-4000-8000-000000000001',workspaceId:'10000000-0000-4000-8000-000000000002',surface:'web' as const}
const binding = {sessionId:'wrun_fixture',turnId:'turn_0',executionId:'10000000-0000-4000-8000-000000000003'}
const input = {recipient:'fixture@example.invalid',body:'Proposed message'}
const definition: ProductCatalogueEntry = {name:'send_email',description:'Send mail',inputSchema:{type:'object'}}

test('native product tool pauses through Eve with exact durable call/input binding',async()=>{
  const requests:ProductOperation[]=[]
  const rpc:typeof productRpc = async <T>(_scope:EveScope,request:ProductOperation)=>{assert.deepEqual(_scope,scope);requests.push(request);return {status:'user-approval'} as T}
  const tool=createProductTool(scope,binding,definition,rpc)
  const approval=tool.approval as ApprovalConfiguration<unknown>
  const context={session:{id:binding.sessionId,turn:{id:binding.turnId},auth:{current:scopeAuth(scope)}},callId:'call_1',toolInput:input,abortSignal:new AbortController().signal}
  assert.equal(await approval.request(context as never),'user-approval')
  assert.deepEqual(requests,[{...binding,operation:'approval',name:definition.name,input,callId:'call_1'}])
  assert.equal(await approval.request({...context,session:{...context.session,id:'wrun_other'}} as never),'denied')
  assert.equal(await approval.request({...context,session:{...context.session,auth:{current:scopeAuth({...scope,ownerId:'other'})}}} as never),'denied')
  assert.equal(requests.length,1)
})

test('native approval accepts only original scoped owner and copies no token capability',async()=>{
  const requests:ProductOperation[]=[]
  const rpc:typeof productRpc = async <T>(_scope:EveScope,request:ProductOperation)=>{requests.push(request);return {output:'sent'} as T}
  const tool=createProductTool(scope,binding,definition,rpc)
  const approval=tool.approval as ApprovalConfiguration<unknown>
  const owner=scopeAuth(scope)
  const context={session:{id:binding.sessionId,turn:{id:binding.turnId}},request:{principal:owner},response:{principal:owner,decision:'approve'}}
  assert.deepEqual(await approval.response!(context as never),{status:'allowed'})
  for(const foreign of [scopeAuth({...scope,ownerId:'other'}),scopeAuth({...scope,botId:'other'}),scopeAuth({...scope,workspaceId:'other'}),scopeAuth({...scope,surface:'slack'}),{...owner,authenticator:'unknown'},null]) {
    assert.equal((await approval.response!({...context,response:{...context.response,principal:foreign}} as never)).status,'rejected')
    assert.equal((await approval.response!({...context,request:{principal:foreign}} as never)).status,'rejected')
  }
  const responder={...owner,getToken:()=>{throw new Error('must not access token')},attributes:{...owner.attributes,sourceEventId:'private-original-source'}}
  assert.equal(await tool.execute!(input as never,{callId:'call_1',abortSignal:new AbortController().signal,approval:{responder}} as never),'sent')
  assert.deepEqual(requests,[{...binding,operation:'execute',name:definition.name,input,callId:'call_1',approvalResponder:owner}])
  assert.equal(await tool.execute!(input as never,{callId:'call_2',abortSignal:new AbortController().signal} as never),'sent')
  assert.equal(Object.hasOwn(requests[1],'approvalResponder'),false)
})

test('self-hosted product RPC uses the configured server and reserves the private capability for Cloudflare', async t => {
  t.mock.property(process, 'env', {
    ...process.env,
    MIKKA_EDITION: 'community',
    MIKKA_EVE_HOST: 'local',
    MIKKA_APP_ORIGIN: 'https://mikka-installation.example.invalid',
    BETTER_AUTH_URL: 'https://login.example.invalid',
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    MIKKA_EVE_PRODUCT_TOKEN: randomBytes(32).toString('hex'),
  })
  const calls: Request[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    calls.push(new Request(url, options))
    return Response.json({ accepted: true })
  })
  const operation: ProductOperation = { ...binding, operation: 'prepare' }
  assert.deepEqual(await productRpc(scope, operation), { accepted: true })
  assert.equal(calls.length, 1)
  const [request] = calls
  assert.equal(request.method, 'POST')
  assert.equal(request.url, 'https://mikka-installation.example.invalid/mikka/api/internal/eve/tools')
  assert.equal(request.redirect, 'error')
  assert.deepEqual(internalEveScope(request.headers.get('authorization')), scope)
  assert.equal(request.headers.has('x-mikka-product-capability'), false)
  assert.deepEqual(await request.json(), operation)

  process.env.MIKKA_EVE_HOST = 'cloudflare'
  delete process.env.MIKKA_EVE_PRODUCT_TOKEN
  await assert.rejects(productRpc(scope, operation), { message: 'agentToolUnavailable' })
  assert.equal(calls.length, 1)
})


test('Cloudflare product RPC carries the native Eve scope without a second signed expiring credential', async t => {
  t.mock.property(process, 'env', { ...process.env, MIKKA_EVE_HOST: 'cloudflare', MIKKA_EVE_PRODUCT_TOKEN: 'private-runtime-capability', BETTER_AUTH_SECRET: '' })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    calls++
    const request = new Request(url, options)
    assert.equal(request.url, 'https://product.internal/mikka/api/internal/eve/tools')
    assert.equal(request.headers.get('authorization'), null)
    assert.deepEqual(JSON.parse(request.headers.get('x-mikka-eve-scope')!), scope)
    assert.equal(request.headers.get('x-mikka-product-capability'), 'private-runtime-capability')
    return Response.json({ accepted: true })
  })
  assert.deepEqual(await productRpc(scope, { ...binding, operation: 'prepare' }), { accepted: true })
  assert.equal(calls, 1)
})
