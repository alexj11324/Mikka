import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { hasUnsafeModes, isDocsOnly } from './ci-docs-only.mjs'

test('approved documentation paths are documentation-only', () => {
  const files = [
    'README.md',
    'README.zh-CN.md',
    'docs/design/glossary.md',
    'tasks/lessons.md',
    'LICENSE',
    '.github/pull_request_template.md',
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
    'docs/tool.mjs',
    'tasks/migration.sql',
    'docs/generated.js',
    'docs/assets/architecture-light.svg',
    'docs/AGENTS.md',
    'scripts/generate-diagrams.mjs',
    'scripts/diagram-svg.mjs',
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

test('non-executable regular files including added and deleted files are safe', () => {
  for (const line of [
    ':100644 100644 aaaa bbbb M\tREADME.md',
    ':000000 100644 0000 bbbb A\tdocs/new.md',
    ':100644 000000 aaaa 0000 D\tdocs/old.md',
  ]) {
    assert.equal(hasUnsafeModes(line.replace('\t', '\0') + '\0'), false, line)
  }
  assert.equal(hasUnsafeModes(''), false)
})

test('symlinks, gitlinks and unmerged entries fail closed', () => {
  for (const line of [
    ':100644 120000 aaaa bbbb T\tdocs/link',
    ':100755 100755 aaaa bbbb M\tdocs/runner.md',
    ':000000 160000 0000 1234 A\tsubmodule',
    ':000000 000000 0000 0000 U\tdocs/conflict.md',
  ]) {
    assert.equal(hasUnsafeModes(line.replace('\t', '\0') + '\0'), true, line)
  }
})


test('real git diffs handle rename, deletion, executable files and missing base safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-gate-'))
  const script = resolve('scripts/ci-docs-only.mjs')
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  const classify = (base, head = 'HEAD') => execFileSync(process.execPath, [script, '--base', base, '--head', head], { cwd: dir, encoding: 'utf8' })
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
    mkdirSync(join(dir, 'docs')); writeFileSync(join(dir, 'code.js'), 'code\n'); writeFileSync(join(dir, 'docs', 'old.md'), 'docs\n')
    git('add', '.'); git('commit', '-qm', 'base'); git('tag', 'base')
    git('mv', 'code.js', 'docs/code.md'); git('commit', '-qm', 'move code')
    assert.match(classify('base'), /docs_only=false/)
    git('reset', '--hard', 'base'); git('rm', 'docs/old.md'); git('commit', '-qm', 'delete docs')
    assert.match(classify('base'), /docs_only=true/)
    mkdirSync(join(dir, 'docs'), { recursive: true }); writeFileSync(join(dir, 'docs', 'tool.md'), 'tool\n'); git('add', '.'); git('update-index', '--chmod=+x', 'docs/tool.md'); git('commit', '-qm', 'executable')
    assert.match(classify('base'), /docs_only=false/)
    assert.match(classify('missing'), /docs_only=false/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
