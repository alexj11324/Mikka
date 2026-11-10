import assert from 'node:assert/strict'
import test from 'node:test'
import { delivered, inFlight, marked, outgoingKey, queued, sendFailureState, submissionBody, unsettled } from '../lib/outbox.ts'

test('an unconfirmed message keeps one UUID and immutable body through bubble and composer retries', () => {
  const key = outgoingKey()
  assert.match(key, /^[0-9a-f-]{36}$/)
  const image = { uri: 'file:///photo.jpg', dataUrl: 'data:image/jpeg;base64,/9j/' }
  let pending = queued([], key, '请处理', [image], { botId: 'bot', chatKey: 'coordinator', context: 7 })
  const original = submissionBody(pending[0])
  image.dataUrl = 'changed attachment'
  assert.equal(original.images?.[0].dataUrl, 'data:image/jpeg;base64,/9j/', 'attachment input cannot mutate a held identity')
  pending = marked(pending, key, sendFailureState(new Error('lost response')))
  assert.equal(inFlight(pending), false)
  assert.equal(pending[0].state, 'unconfirmed')
  const retry = unsettled(pending, '请处理', [{ ...image, dataUrl: original.images![0].dataUrl }], 'coordinator', 7)!
  assert.equal(retry.submissionId, key)
  assert.deepEqual(submissionBody(retry), original)
  assert.equal(unsettled(pending, 'edited', [], 'coordinator', 7), undefined)
  assert.equal(unsettled(pending, '请处理', retry.images, 'another chat', 7), undefined)
  assert.equal(unsettled(pending, '请处理', retry.images, 'coordinator', 8), undefined, 'an account/workspace change cannot reuse the previous context')
  assert.equal(unsettled(delivered(pending, key), '请处理', retry.images, 'coordinator', 7), undefined, 'a confirmed send may be intentionally sent again with a new identity')
})

test('transport failures stay unconfirmed while known validation/auth refusals are not sent', () => {
  for (const failure of [Error('network'), { status: 408 }, { status: 500 }, { status: 502 }, null]) assert.equal(sendFailureState(failure), 'unconfirmed')
  for (const status of [400, 401, 403, 404, 409, 413]) assert.equal(sendFailureState({ status }), 'failed')
  assert.equal(outgoingKey(() => 'native-uuid'), 'native-uuid', 'Expo supplies the native UUID implementation without a new native module')
})

test('task creation visibility is immutable through a lost response; editing scope starts another submission',()=>{
  const creation={visibility:'private' as const,projectId:'e68ce783-25e8-459a-a071-ed5dad443917'}
  const [held]=queued([],outgoingKey(),'Create a private task',[],{botId:'bot',context:4,taskCreation:creation})
  const first=submissionBody(held)
  creation.projectId='c0d1cda8-7cb9-4c38-be53-01a3e2d62959'
  assert.equal(first.taskCreation?.projectId,'e68ce783-25e8-459a-a071-ed5dad443917')
  const again=unsettled([held],held.text,[],'bot',4,first.taskCreation)
  assert.equal(again?.submissionId,held.submissionId)
  assert.deepEqual(submissionBody(again!),first)
  assert.equal(unsettled([held],held.text,[],'bot',4),undefined,'ordinary chat cannot reuse a task creation receipt')
  assert.equal(unsettled([held],held.text,[],'bot',4,{...first.taskCreation!,visibility:'shared'}),undefined)
  assert.equal(unsettled([held],held.text,[],'bot',4,creation),undefined,'switching project cannot mutate an unsettled request')
})
