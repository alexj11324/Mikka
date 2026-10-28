import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs'
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
    git('reset', '--hard', 'base'); git('rm', 'code.js'); git('commit', '-qm', 'delete code')
    assert.match(classify('base'), /docs_only=false/)
    git('reset', '--hard', 'base'); git('mv', 'docs/old.md', 'moved.js'); git('commit', '-qm', 'move docs to code')
    assert.match(classify('base'), /docs_only=false/)
    git('reset', '--hard', 'base'); symlinkSync('old.md', join(dir, 'docs', 'link.md')); git('add', '.'); git('commit', '-qm', 'symlink')
    assert.match(classify('base'), /docs_only=false/)
    git('reset', '--hard', 'base'); writeFileSync(join(dir, 'docs', 'new.md'), 'docs\n'); git('add', '.'); git('commit', '-qm', 'docs')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    const base = execFileSync('git', ['rev-parse', 'base'], { cwd: dir, encoding: 'utf8' }).trim()
    const eventFile = join(dir, 'event.json')
    writeFileSync(eventFile, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head, repo: { full_name: 'fork/repo' } } } }))
    const event = execFileSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventFile } })
    assert.match(event, /docs_only=true/)
    writeFileSync(eventFile, JSON.stringify({ pull_request: { base: { sha: '0'.repeat(40) }, head: { sha: head } } }))
    const missing = execFileSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventFile } })
    assert.match(missing, /docs_only=false/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('all required gates reject failed classification and skipped full jobs', () => {
  for (const file of ['.github/workflows/ui-policy.yml', '.github/workflows/browser-tests.yml']) {
    const source = readFileSync(file, 'utf8')
    const blocks = [...source.matchAll(/      - name: Require the full suite unless only documentation changed\n([\s\S]*?)(?=\n  [a-z][a-z-]*:|$)/g)]
    assert.equal(blocks.length, file.includes('ui-policy') ? 2 : 1)
    for (const [, block] of blocks) {
      const script = block.split('        run: |\n')[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
      const result = (changes, docs, full) => {
        try { execFileSync('bash', ['-e', '-c', script], { env: { ...process.env, CHANGES_RESULT: changes, DOCS_ONLY: docs, FULL_RESULT: full }, stdio: 'ignore' }); return true } catch { return false }
      }
      assert.equal(result('failure', 'true', 'skipped'), false)
      assert.equal(result('success', 'false', 'skipped'), false)
      assert.equal(result('success', 'false', 'failure'), false)
      assert.equal(result('success', 'false', 'success'), true)
      assert.equal(result('success', 'true', 'skipped'), true)
    }
  }
})
