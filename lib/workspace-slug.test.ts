import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceSlug, workspaceSlugSuffix } from './workspace-slug'

test('suggests a usable workspace URL for any name', () => {
  const valid = /^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$/
  assert.equal(workspaceSlug('Design Team', 'k3f9a'), 'design-team')
  assert.equal(workspaceSlug('Café Ops', 'k3f9a'), 'cafe-ops')
  assert.equal(workspaceSlug('产品研发', 'k3f9a'), 'ws-k3f9a')
  assert.equal(workspaceSlug('QA 第二工作区', 'k3f9a'), 'qa-k3f9a')
  assert.equal(workspaceSlug('  ', 'k3f9a'), '')
  for (const name of ['产品研发', 'QA 第二工作区', 'A', 'Design Team']) assert.match(workspaceSlug(name, workspaceSlugSuffix()), valid, name)
  assert.match(workspaceSlugSuffix(), /^[a-z0-9]{5}$/)
})
