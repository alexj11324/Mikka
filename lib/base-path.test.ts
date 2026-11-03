import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withBasePath } from './base-path'
test('prefixing twice is identical to prefixing once, with path boundaries and suffixes preserved', () => {
  for (const path of [
    '/',
    '/?q=1',
    '/#draft',
    '/api/files',
    '/api/files?download#file',
    '/mikka',
    '/mikka/',
    '/mikka/api/files',
    '/mikka?query=1',
    '/mikka#file',
  ]) {
    const once = withBasePath(path, '/mikka')
    assert.equal(withBasePath(once, '/mikka'), once, path)
    assert.equal(once.includes('/mikka/mikka/'), false, path)
  }
  assert.equal(withBasePath('/mikkabox', '/mikka'), '/mikka/mikkabox')
  assert.equal(withBasePath('/api/file', ''), '/api/file')
  for (const path of ['https://example.com/file', '//example.com/file', '#draft'])
    assert.equal(withBasePath(path, '/mikka'), path)
})
