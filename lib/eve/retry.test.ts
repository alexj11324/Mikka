import assert from 'node:assert/strict'
import test from 'node:test'
import {eveRetrySubmission} from './retry'

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
