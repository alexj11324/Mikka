import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveWritePermission } from './write-policy'

test('without the tool\'s metadata an unnamed action asks, and any deny or ask restricts an allow', () => {
  assert.equal(resolveWritePermission('write_document', [{}]), 'ask')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'allow' }, { write_document: 'allow' }]), 'allow')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'allow' }, {}]), 'allow', 'a layer that is silent does not inject the fallback')
  assert.equal(resolveWritePermission('write_document', [{}, { write_document: 'allow' }]), 'allow')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'allow' }, { write_document: 'deny' }]), 'deny')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'deny' }, { write_document: 'allow' }]), 'deny')
  assert.equal(resolveWritePermission('write_document', [{ network: 'allow' }]), 'ask')
  for (const layers of [[], [null], [{ write_document: 'other' }]]) assert.throws(() => resolveWritePermission('write_document', layers), /writePolicyUnavailable/)
})

test('the workspace choice is the decision; absence falls back', () => {
  assert.equal(resolveWritePermission('write_document', [{}], 'allow'), 'allow')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'allow' }], 'ask'), 'allow', 'an explicit workspace allow beats the tool default')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'ask' }], 'allow'), 'ask')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'deny' }], 'allow'), 'deny')
})
