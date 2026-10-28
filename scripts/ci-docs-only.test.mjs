import assert from 'node:assert/strict'
import test from 'node:test'

import { isDocsOnly } from './ci-docs-only.mjs'

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
