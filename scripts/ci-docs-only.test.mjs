import assert from 'node:assert/strict'
import test from 'node:test'

import { hasUnsafeModes, isDocsOnly } from './ci-docs-only.mjs'

test('root documents, docs assets and the diagram generator are documentation-only', () => {
  const files = [
    'README.md',
    'README.zh-CN.md',
    'docs/assets/architecture-light.svg',
    'docs/design/glossary.md',
    'tasks/lessons.md',
    'LICENSE',
    '.github/pull_request_template.md',
    'scripts/generate-diagrams.mjs',
    'scripts/diagram-svg.mjs',
  ]
  assert.equal(isDocsOnly(files), true)
})

test('code, workflows, configuration, messages and public assets are not documentation-only', () => {
  for (const file of [
    'app/page.tsx',
    '.github/workflows/ui-policy.yml',
    'package.json',
    'pnpm-lock.yaml',
    'messages/en.json',
    'scripts/ci-docs-only.mjs',
    'agents/default/agent.json',
    'agents/README.md',
    'public/brand/mikka-icon-light.svg',
  ]) {
    assert.equal(isDocsOnly([file]), false, file)
  }
})

test('one code file makes a mixed change run the full suites', () => {
  assert.equal(isDocsOnly(['README.md', 'app/page.tsx']), false)
})

test('an empty change set is never treated as documentation-only', () => {
  assert.equal(isDocsOnly([]), false)
})

test('a docs path with a non-regular mode is not documentation-only', () => {
  assert.equal(isDocsOnly(['docs/link'], true), false)
})

test('regular file modes including added and deleted files are safe', () => {
  for (const line of [
    ':100644 100644 aaaa bbbb M\tREADME.md',
    ':100755 100755 aaaa bbbb M\tscripts/tool.mjs',
    ':000000 100644 0000 bbbb A\tdocs/new.md',
    ':100644 000000 aaaa 0000 D\tdocs/old.md',
    ':100644 100644 aaaa bbbb R100\tdocs/a.md\tdocs/b.md',
  ]) {
    assert.equal(hasUnsafeModes(line), false, line)
  }
  assert.equal(hasUnsafeModes(''), false)
})

test('symlinks, gitlinks and unmerged entries fail closed', () => {
  for (const line of [
    ':100644 120000 aaaa bbbb T\tdocs/link',
    ':000000 160000 0000 1234 A\tsubmodule',
    ':000000 000000 0000 0000 U\tdocs/conflict.md',
  ]) {
    assert.equal(hasUnsafeModes(line), true, line)
  }
})
