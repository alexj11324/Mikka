import assert from 'node:assert/strict'
import test from 'node:test'
import { canAnswerCard, outgoingKey, personalMessage, sendFailureState, submissionBody, unsettled } from '../lib/outbox.ts'

test('an unconfirmed message keeps one UUID and immutable body through bubble and composer retries', () => {
  const key = outgoingKey()
  assert.match(key, /^[0-9a-f-]{36}$/)
  const image = { uri: 'file:///photo.jpg', dataUrl: 'data:image/jpeg;base64,/9j/' }
  const first = personalMessage(key, '请处理', [image], { botId: 'bot', chatKey: 'coordinator', context: 7 })
  const pending = [{ ...first, phase: 'failed' as const, error: 'unconfirmed' }]
  const original = submissionBody(pending[0])
  image.dataUrl = 'changed attachment'
  assert.equal(original.images?.[0].dataUrl, 'data:image/jpeg;base64,/9j/', 'attachment input cannot mutate a held identity')
  assert.equal(pending[0].phase, 'failed')
  assert.equal(pending[0].error, 'unconfirmed')
  const retry = unsettled(pending, '请处理', [{ ...image, dataUrl: original.images![0].dataUrl }], 'coordinator', 7)!
  assert.equal(retry.submissionId, key)
  assert.deepEqual(submissionBody(retry), original)
  assert.equal(unsettled(pending, 'edited', [], 'coordinator', 7), undefined)
  assert.equal(unsettled(pending, '请处理', retry.images, 'another chat', 7), undefined)
  assert.equal(unsettled(pending, '请处理', retry.images, 'coordinator', 8), undefined, 'an account/workspace change cannot reuse the previous context')
  assert.equal(unsettled([{ ...first, phase: 'accepted' }], '请处理', retry.images, 'coordinator', 7), undefined, 'a confirmed send may be intentionally sent again with a new identity')
})

test('transport failures stay unconfirmed while known validation/auth refusals are not sent', () => {
  for (const failure of [Error('network'), { status: 408 }, { status: 500 }, { status: 502 }, null]) assert.equal(sendFailureState(failure), 'unconfirmed')
  for (const status of [400, 401, 403, 404, 409, 413]) assert.equal(sendFailureState({ status }), 'failed')
  assert.equal(outgoingKey(() => 'native-uuid'), 'native-uuid', 'Expo supplies the native UUID implementation without a new native module')
})

test('only the originating choice can reopen an unsettled answer and transport keeps its immutable body', () => {
  const draft = [personalMessage('op1', 'Keep the original draft', [], { sourceCardId: 'card-a', chatKey: 'chat', context: 3, botId: null })]
  assert.equal(canAnswerCard([], 'card-a'), true)
  assert.equal(canAnswerCard(draft, 'card-a'), false)
  for (const state of ['failed', 'unconfirmed'] as const) {
    const saved = [{ ...draft[0], phase: 'failed' as const, error: state }]
    assert.equal(canAnswerCard(saved, 'card-a'), true)
    assert.equal(canAnswerCard(saved, 'card-b'), false)
    assert.equal(canAnswerCard([...saved, personalMessage('other', 'Another message', [], { botId: null, context: 3, chatKey: 'chat' })], 'card-a'), false)
    const same = unsettled(saved, 'Keep the original draft', [], 'chat', 3, 'card-a')!
    assert.equal(same.submissionId, 'op1')
    assert.equal(unsettled(saved, 'Keep the original draft', [], 'chat', 3), undefined)
    assert.equal(unsettled(saved, 'Keep the original draft', [], 'chat', 3, 'another-card'), undefined)
    assert.deepEqual(submissionBody(same), { text: 'Keep the original draft', botId: null, submissionId: 'op1' })
  }
})
