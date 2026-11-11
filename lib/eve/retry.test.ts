import assert from 'node:assert/strict'
import test from 'node:test'
import {eveRetryHeaders,eveRetrySubmission} from './retry'

test('authenticated mobile retry supplies only a missing Origin and keeps caller credentials',()=>{
  assert.deepEqual(eveRetryHeaders(new Headers({cookie:'mobile=session','x-mikka-workspace-id':'workspace','content-length':'42'}),'https://app.test/mikka'),{
    cookie:'mobile=session','x-mikka-workspace-id':'workspace',origin:'https://app.test',
  })
  assert.deepEqual(eveRetryHeaders(new Headers({authorization:'Bearer current',origin:'https://untrusted.test','sec-fetch-site':'cross-site'}),'https://app.test'),{
    authorization:'Bearer current',origin:'https://untrusted.test','sec-fetch-site':'cross-site',
  })
  assert.equal(eveRetryHeaders(new Headers({cookie:'mobile=session',origin:''}),'https://app.test').origin,'')
  assert.throws(()=>eveRetryHeaders(new Headers(),'https://app.test'),/authRequired/)
})

test('native resend retains canonical text, images and task choices with one UUID per failed turn',()=>{
  const image={dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',mediaType:'image/png'}
  const source={position:4,id:'10000000-0000-4000-8000-000000000001',taskRequestSourceEventId:'10000000-0000-4000-8000-000000000001',payload:{text:'Original quoted text\n\n[Browser notes]\nOriginal note',images:[image],taskDestination:{kind:'cloud'},profileId:'default',taskTitle:'Original title'}}
  const first=eveRetrySubmission('wrun_fixture','turn_0',source)
  assert.deepEqual(first.message,[{type:'text',text:source.payload.text},{type:'file',mediaType:'image/png',data:image.dataUrl}])
  assert.deepEqual(first.options.clientContext,{retryOf:4,taskDestination:{kind:'cloud'},profileId:'default',taskTitle:'Original title'})
  assert.deepEqual(eveRetrySubmission('wrun_fixture','turn_0',source),first)
  assert.match(first.options.headers['x-mikka-submission-id'],/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.notEqual(eveRetrySubmission('wrun_fixture','turn_1',source).options.headers['x-mikka-submission-id'],first.options.headers['x-mikka-submission-id'])
})
