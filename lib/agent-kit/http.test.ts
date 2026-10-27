import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { DEFAULT_AGENT_DEFINITION } from './builtin'
import { createAgentDefinitionHandler } from './http'
import { AgentKitError, type AgentKitStore } from './store'

const origin='https://example.test'
const botId=randomUUID()
function fixture(options:{ owner?:string|null; enabled?:boolean; fail?:Error }={}) {
  const calls:unknown[]=[]
  const store={
    active:async (...args:unknown[]) => { calls.push(['active',...args]);if(options.fail) throw options.fail;return { id:randomUUID(),version:1,definition:DEFAULT_AGENT_DEFINITION } },
    save:async (...args:unknown[]) => { calls.push(['save',...args]);if(options.fail) throw options.fail;return { version:2 } },
  } as unknown as AgentKitStore
  const handler=createAgentDefinitionHandler({ enabled:() => options.enabled!==false,authenticate:async () => options.owner===undefined ? 'owner-a' : options.owner,scope:async (ownerId,bot) => { calls.push(['scope',ownerId,bot]);return {ownerId,botId:bot,workspaceId:bot ? 'workspace-a' : null} },store,defaults:DEFAULT_AGENT_DEFINITION,evaluate:async () => { calls.push(['evaluate']);return {status:'completed'} } })
  const request=(body:unknown,headers:Record<string,string>={}) => new Request(`${origin}/api/bots/${botId}/definition`,{method:'POST',headers:{'Content-Type':'application/json',origin,...headers},body:JSON.stringify(body)})
  return { handler,calls,request }
}
const save=() => ({action:'save',definition:DEFAULT_AGENT_DEFINITION,expectedVersion:1,requestId:randomUUID()})

test('API is gated and does not touch data when disabled or unauthenticated',async () => {
  for (const options of [{enabled:false},{owner:null}]) {
    const f=fixture(options)
    const response=await f.handler(new Request(`${origin}/api/bots/${botId}/definition`),botId)
    assert.equal(response.status,options.enabled===false ? 404 : 401)
    assert.equal(f.calls.length,0)
  }
})
test('cross-origin writes are rejected before authentication or storage',async () => {
  const f=fixture()
  assert.equal((await f.handler(f.request(save(),{origin:'https://evil.test'}),botId)).status,403)
  assert.equal(f.calls.length,0)
})
test('owner and scope are host-derived and cannot be overridden by imported commands',async () => {
  const f=fixture()
  assert.equal((await f.handler(f.request({...save(),ownerId:'other-user'}),botId)).status,400)
  assert.equal(f.calls.filter(call => (call as string[])[0]==='save').length,0)
  assert.equal((await f.handler(f.request(save()),botId)).status,200)
  const call=f.calls.find(value => (value as string[])[0]==='save') as unknown[]
  assert.deepEqual(call[1],{ownerId:'owner-a',botId,workspaceId:'workspace-a'})
})
test('export uses a checksummed document and private no-store headers',async () => {
  const f=fixture()
  const response=await f.handler(new Request(`${origin}/api/bots/${botId}/definition?view=export`),botId)
  assert.equal(response.status,200)
  assert.equal(response.headers.get('cache-control'),'private, no-store')
  const body=await response.json()
  assert.equal(body.format,'mikka.agent');assert.equal(body.checksum.length,64)
})
test('unknown capabilities, code and untrusted evaluation reports cannot enter the API',async () => {
  const f=fixture()
  const bad=[{...save(),definition:{...DEFAULT_AGENT_DEFINITION,execute:'eval()'}},{...save(),definition:{...DEFAULT_AGENT_DEFINITION,tools:['shell']}},{action:'approve',proposalId:randomUUID(),evaluationId:randomUUID(),requestId:randomUUID(),expectedVersion:1,confirm:true,reports:{passed:100}}]
  for(const body of bad) assert.equal((await f.handler(f.request(body),botId)).status,400)
  assert.equal(f.calls.filter(call => (call as string[])[0]==='save').length,0)
})
test('model evaluations require explicit usage consent and do not run from GET',async () => {
  const f=fixture()
  const body={action:'evaluate',proposalId:randomUUID(),requestId:randomUUID(),mode:'live',consentToModelUsage:false}
  assert.equal((await f.handler(f.request(body),botId)).status,400)
  assert.equal((await f.handler(f.request({...body,consentToModelUsage:true}),botId)).status,200)
  assert.equal(f.calls.filter(call => (call as string[])[0]==='evaluate').length,1)
})
test('request byte limits are enforced without relying on Content-Length',async () => {
  const f=fixture()
  const request=f.request({payload:'x'.repeat(270_000)})
  assert.equal(request.headers.has('content-length'),false)
  assert.equal((await f.handler(request,botId)).status,413)
})
test('unsupported media types and invalid JSON have explicit client errors',async () => {
  const f=fixture()
  assert.equal((await f.handler(f.request(save(),{'Content-Type':'text/plain'}),botId)).status,415)
  const request=new Request(`${origin}/api/definition`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{'})
  assert.equal((await f.handler(request,botId)).status,400)
})
test('conflicts are distinct from infrastructure errors, and diagnostics stay private',async () => {
  const conflict=fixture({fail:new AgentKitError('agentVersionConflict')})
  assert.equal((await conflict.handler(conflict.request(save()),botId)).status,409)
  const infra=fixture({fail:new Error('postgres://secret-password@private-host')})
  const response=await infra.handler(infra.request(save()),botId)
  assert.equal(response.status,500)
  assert.doesNotMatch(await response.text(),/secret-password|private-host/)
})
