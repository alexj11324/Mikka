import assert from 'node:assert/strict'
import {IncomingMessage,ServerResponse} from 'node:http'
import {Socket} from 'node:net'
import test from 'node:test'
import {NodeRequest} from 'srvx/node'
import {forwardEveRequest} from './forward-request'

test('rewritten native submissions preserve real srvx request headers/body without Undici private state',async()=>{
  const incoming=new IncomingMessage(new Socket())
  incoming.method='POST';incoming.url='/eve/v1/session/wrun_fixture?botId=fixture';incoming.headers={host:'app.test','content-type':'application/json','x-mikka-submission-id':'fixture','cookie':'fixture=cookie'}
  incoming.rawHeaders=Object.entries(incoming.headers).flatMap(([name,value])=>[name,String(value)])
  const original=new NodeRequest({req:incoming,res:new ServerResponse(incoming),trustProxy:false})
  assert.throws(()=>new Request(original,{method:'POST',body:'{}'}),/private member/)
  const payload=JSON.stringify({message:'Hello',idempotencyKey:'fixture'})
  const forwarded=forwardEveRequest(original,original.url,payload)
  assert.equal(forwarded.method,'POST')
  assert.equal(forwarded.url,original.url)
  assert.equal(forwarded.headers.get('cookie'),'fixture=cookie')
  assert.equal(forwarded.headers.get('x-mikka-submission-id'),'fixture')
  assert.equal(await forwarded.text(),payload)
  const url=new URL(original.url);url.searchParams.set('startIndex','0')
  incoming.method='GET'
  const reader=new NodeRequest({req:incoming,res:new ServerResponse(incoming),trustProxy:false})
  const stream=forwardEveRequest(reader,url)
  assert.equal(stream.method,'GET')
  assert.equal(new URL(stream.url).searchParams.get('startIndex'),'0')
  incoming.socket.destroy()
})
