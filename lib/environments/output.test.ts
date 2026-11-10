import assert from 'node:assert/strict'
import test from 'node:test'
import { BoundedOutput } from './output'

test('each stream keeps its own cap and marks later output truncated', () => {
  const output = new BoundedOutput(8)
  output.append('stdout', '12345')
  output.append('stderr', 'abcdef')
  output.append('stdout', '6789')
  assert.deepEqual(output.snapshot(), { stdout: '12345678', stderr: 'abcdef', truncated: true })
})

test('a chunk that crosses the cap keeps the longest whole-code-point prefix', () => {
  const output = new BoundedOutput(5)
  output.append('stdout', 'ab测试x')
  const snapshot = output.snapshot()
  assert.equal(snapshot.stdout, 'ab测')
  assert.equal(snapshot.truncated, true)
  output.append('stdout', 'more')
  assert.equal(output.snapshot().stdout, 'ab测')
})

test('masking happens on the accumulated text, so a split secret is still masked', () => {
  const output = new BoundedOutput(1024)
  output.append('stdout', 'token sk-live-')
  output.append('stdout', 'abcdefgh')
  const masked = output.snapshot(text => text.replace('sk-live-abcdefgh', '[secret:key]'))
  assert.equal(masked.stdout, 'token [secret:key]')
})

test('an empty stream stays empty and untruncated', () => {
  assert.deepEqual(new BoundedOutput().snapshot(), { stdout: '', stderr: '', truncated: false })
})
