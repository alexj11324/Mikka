import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { visualObservation } from './visual-observation'

test('visual observation supplies actual JPEG bytes separately from page text', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const [message] = visualObservation('find the button', { title: 'Fixture' }, 'start', jpeg.toString('base64'))
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[1].type, 'image')
  assert.deepEqual(message.content[1].image, jpeg)
  assert.doesNotMatch(message.content[0].text!, new RegExp(jpeg.toString('base64')))
  assert.throws(() => visualObservation('x', {}, 'x', 'not-a-jpeg'))
  assert.throws(() => visualObservation('x', {}, 'x', Buffer.from('not jpeg').toString('base64')))
})
