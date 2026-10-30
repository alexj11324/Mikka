import assert from 'node:assert/strict'
import test from 'node:test'
import { computerPermission } from './permission'

test('computer policy defaults to allow, preserves deny and refuses unknown stored values', () => {
  for (const stored of [undefined, null, 'allow', 'ask']) assert.equal(computerPermission(stored), 'allow')
  assert.equal(computerPermission('deny'), 'deny')
  for (const stored of ['', 'unknown', false, 0, {}]) assert.equal(computerPermission(stored), null)
})
