import assert from 'node:assert/strict'
import test from 'node:test'
import { quotes } from '../lib/message-gesture.ts'

test('letting go quotes a message dragged past the mark, or flicked from a short way', () => {
  assert.equal(quotes(56, 0), true, 'past the mark, however slowly')
  assert.equal(quotes(55, 0), false, 'short of the mark and slow')
  assert.equal(quotes(24, 650), true, 'a flick from 24 points')
  assert.equal(quotes(30, 649), false, 'not quite fast enough')
  assert.equal(quotes(23, 2000), false, 'too short even for a flick')
  assert.equal(quotes(40, -900), false, 'moving back the other way')
})
