import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveWritePermission, resolveScopedWritePermission } from './write-policy'

test('without the tool\'s metadata an unnamed action asks, denies take precedence, and allow requires every layer', () => {
  assert.equal(resolveWritePermission('write_document', [{}]), 'ask')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'allow' }, { write_document: 'allow' }]), 'allow')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'allow' }, {}]), 'ask')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'allow' }, { write_document: 'deny' }]), 'deny')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'deny' }, { write_document: 'allow' }]), 'deny')
  assert.equal(resolveWritePermission('write_document', [{ network: 'allow' }]), 'ask')
  for (const layers of [[], [null], [{ write_document: 'other' }]]) assert.throws(() => resolveWritePermission('write_document', layers), /writePolicyUnavailable/)
})

test('workspace choice narrows the agent decision; absent workspace choice inherits', () => {
 assert.equal(resolveScopedWritePermission('write_document',{write_document:'allow'},{}),'allow')
 assert.equal(resolveScopedWritePermission('write_document',{write_document:'allow'},{write_document:'ask'}),'ask')
 assert.equal(resolveScopedWritePermission('write_document',{write_document:'allow'},{write_document:'deny'}),'deny')
 assert.equal(resolveScopedWritePermission('write_document',{write_document:'deny'},{write_document:'allow'}),'deny')
 assert.equal(resolveScopedWritePermission('write_document',{}, {write_document:'allow'}),'ask')
})

test('an unnamed action follows the tool\'s own default; explicit ask and deny still narrow (decision 2026-10-31)', () => {
  assert.equal(resolveWritePermission('write_document', [{}], 'allow'), 'allow')
  assert.equal(resolveWritePermission('write_document', [{}], 'ask'), 'ask')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'ask' }], 'allow'), 'ask')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'deny' }], 'allow'), 'deny')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'allow' }], 'ask'), 'allow')
  assert.equal(resolveScopedWritePermission('write_document', {}, {}, 'allow'), 'allow')
  assert.equal(resolveScopedWritePermission('write_document', {}, { write_document: 'ask' }, 'allow'), 'ask')
  assert.equal(resolveScopedWritePermission('write_document', {}, { write_document: 'deny' }, 'allow'), 'deny')
  assert.equal(resolveScopedWritePermission('write_document', {}, { write_document: 'allow' }, 'ask'), 'ask')
})
