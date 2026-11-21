import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCliFold, applyExternalFold, foldCliRunPolicy, foldExternalWritePermissions } from './workspace-policy-fold'

test('external fold keeps deny/ask only and never copies an allow', () => {
  assert.deepEqual(foldExternalWritePermissions([
    { slack: 'allow', notion: 'deny' },
    { slack: 'deny', gmail: 'ask' },
  ]), { notion: 'deny', slack: 'deny', gmail: 'ask' })
  assert.deepEqual(foldExternalWritePermissions([{ slack: 'allow' }]), {})
  // browser ask is not an option; a browser deny is folded
  assert.deepEqual(foldExternalWritePermissions([{ browser_payment: 'ask', browser_browse: 'deny' }]), { browser_browse: 'deny' })
  // the retired pull-request key and a normalized git_push ask are not folded
  assert.deepEqual(foldExternalWritePermissions([{ github_pull_request: 'deny', git_push: 'ask' }]), {})
  assert.throws(() => foldExternalWritePermissions([{ 'Bad-Key': 'deny' }]))
  assert.throws(() => foldExternalWritePermissions([{ slack: 'maybe' }]))
  assert.throws(() => foldExternalWritePermissions([[]]))
})

test('cli fold is restrictive, intersects the network allow-list and carries read_only', () => {
  assert.deepEqual(foldCliRunPolicy([
    { permissions: { install_dependency: 'allow', network: 'ask', git_push: 'deny' }, networkAllow: ['a.com', 'b.com'], approvalMode: 'ask' },
    { permissions: { install_dependency: 'deny', network: 'allow', git_push: 'ask' }, networkAllow: ['b.com'], approvalMode: 'read_only' },
  ]), { permissions: { install_dependency: 'deny', network: 'ask', git_push: 'deny' }, networkAllow: ['b.com'], approvalMode: 'read_only' })
  assert.deepEqual(foldCliRunPolicy([{ networkAllow: [] }, { networkAllow: ['a.com'] }]), { networkAllow: [] })
  // defaults are not a fold source; they are preserved by applyCliFold
  assert.deepEqual(foldCliRunPolicy([{ defaults: { permissions: { network: 'deny' } } }]), {})
  assert.throws(() => foldCliRunPolicy([{ permissions: { computer_use: 'allow' } }]))
  assert.throws(() => foldCliRunPolicy([{ networkAllow: ['not a domain'] }]))
})

test('folds merge into the workspace layer without dropping its choices or defaults', () => {
  assert.deepEqual(applyExternalFold({ slack: 'allow', gmail: 'ask' }, { gmail: 'deny' }), { slack: 'allow', gmail: 'deny' })
  assert.deepEqual(applyCliFold({ permissions: { install_dependency: 'allow' }, defaults: { permissions: { network: 'allow' } } }, { permissions: { network: 'deny' }, approvalMode: 'read_only' }), {
    permissions: { install_dependency: 'allow', network: 'deny' },
    defaults: { permissions: { network: 'allow' } },
    approvalMode: 'read_only',
  })
})
