import assert from 'node:assert/strict'
import test from 'node:test'
import { httpUrl } from './safe-url'

test('only http(s) links reach an href', () => {
  assert.equal(httpUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(httpUrl('http://example.com'), 'http://example.com/')
  assert.equal(httpUrl('javascript:alert(1)'), null)
  assert.equal(httpUrl('JaVaScRiPt:alert(1)'), null)
  assert.equal(httpUrl('data:text/html,<script>1</script>'), null)
  assert.equal(httpUrl('vbscript:msgbox(1)'), null)
  assert.equal(httpUrl('//example.com'), null)
  assert.equal(httpUrl('/relative'), null)
  assert.equal(httpUrl(''), null)
  assert.equal(httpUrl(null), null)
})

test('a base only accepts what resolves to http(s)', () => {
  assert.equal(httpUrl('/issues/1', 'https://mikka.app'), 'https://mikka.app/issues/1')
  assert.equal(httpUrl('javascript:alert(1)', 'https://mikka.app'), null)
})
