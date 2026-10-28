import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
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


test('real git diffs retain all fixtures while testing rename, deletion and event boundaries', () => {
  // Never check out, reset, remove, or clean a fixture. Deletions and renames
  // are represented by new immutable tree objects, with all old objects kept.
  const dir = mkdtempSync(join(tmpdir(), 'docs-gate-retained-'))
  console.log(`Retained docs gate evidence: ${dir}`)
  const script = resolve('scripts/ci-docs-only.mjs')
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  }
  const git = (args, input) => execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
    cwd: dir, env, input, encoding: 'utf8',
  }).trim()
  const record = (name, data) => writeFileSync(join(dir, name), JSON.stringify(data, null, 2), { flag: 'wx' })
  const classify = (base, head) => execFileSync(process.execPath, [script, '--base', base, '--head', head], { cwd: dir, env, encoding: 'utf8' })
  mkdirSync(join(dir, 'empty-template'))
  git(['init', '--bare', '--template=empty-template', '.'])
  const code = git(['hash-object', '-w', '--stdin'], 'code\n')
  const docs = git(['hash-object', '-w', '--stdin'], 'docs\n')
  const tree = entries => git(['mktree'], entries.map(([mode, type, oid, name]) => `${mode} ${type} ${oid}\t${name}\n`).join(''))
  const root = (docsEntries, includeCode = true, extra = []) => tree([
    ...(includeCode ? [['100644', 'blob', code, 'code.js']] : []),
    ['040000', 'tree', tree(docsEntries), 'docs'], ...extra,
  ])
  const oldDocs = ['100644', 'blob', docs, 'old.md']
  const base = git(['commit-tree', root([oldDocs]), '-m', 'base'])
  record('base.json', { base })
  const cases = [
    ['rename-code-into-docs', root([oldDocs, ['100644', 'blob', code, 'code.md']], false), false],
    ['delete-docs', root([]), true],
    ['executable-docs', root([oldDocs, ['100755', 'blob', docs, 'tool.md']]), false],
    ['delete-code', root([oldDocs], false), false],
    ['rename-docs-into-code', root([], true, [['100644', 'blob', docs, 'moved.js']]), false],
    ['symlink', root([oldDocs, ['120000', 'blob', docs, 'link.md']]), false],
    ['add-docs', root([oldDocs, ['100644', 'blob', docs, 'new.md']]), true],
  ]
  let docsHead
  for (const [name, treeId, expected] of cases) {
    const head = git(['commit-tree', treeId, '-p', base, '-m', name])
    const output = classify(base, head)
    record(`${name}.json`, { base, head, treeId, expected, output })
    assert.match(output, new RegExp(`docs_only=${expected}`), name)
    if (name === 'add-docs') docsHead = head
  }
  const unavailable = classify('missing', docsHead)
  record('missing-base.json', { output: unavailable })
  assert.match(unavailable, /docs_only=false/)
  for (const [name, baseSha, expected] of [['fork', base, true], ['empty-base', '0'.repeat(40), false]]) {
    const eventFile = join(dir, `${name}-event.json`)
    record(`${name}-event.json`, { pull_request: { base: { sha: baseSha }, head: { sha: docsHead, repo: { full_name: 'fork/repo' } } } })
    const output = execFileSync(process.execPath, [script], {
      cwd: dir, encoding: 'utf8', env: { ...env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventFile },
    })
    record(`${name}-result.json`, { output })
    assert.match(output, new RegExp(`docs_only=${expected}`))
  }
})


test('all required gates reject failed classification and skipped full jobs', () => {
  for (const file of ['.github/workflows/ui-policy.yml', '.github/workflows/browser-tests.yml']) {
    const source = readFileSync(file, 'utf8')
    const blocks = [...source.matchAll(/      - name: Require the full suite unless only documentation changed\n([\s\S]*?)(?=\n  [a-z][a-z-]*:|$)/g)]
    assert.equal(blocks.length, file.includes('ui-policy') ? 2 : 1)
    for (const [, block] of blocks) {
      const script = block.split('        run: |\n')[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
      const result = (changes, docs, full) => {
        try { execFileSync('bash', ['-e', '-c', script], { env: { PATH: process.env.PATH, CHANGES_RESULT: changes, DOCS_ONLY: docs, FULL_RESULT: full }, stdio: 'ignore' }); return true } catch { return false }
      }
      assert.equal(result('failure', 'true', 'skipped'), false)
      assert.equal(result('success', 'false', 'skipped'), false)
      assert.equal(result('success', 'false', 'failure'), false)
      assert.equal(result('success', 'false', 'success'), true)
      assert.equal(result('success', 'true', 'skipped'), true)
    }
  }
})


test('the exact trusted-classifier workflow step executes ESM from a retained temporary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-gate-launch-retained-'))
  console.log(`Retained workflow launcher fixture: ${dir}`)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const git = join(bin, 'git')
  writeFileSync(git, `#!/bin/sh
case "$1" in
  fetch|diff) exit 0 ;;
  show) cat "$FIXTURE_CLASSIFIER" ;;
  *) exit 1 ;;
esac
`, { flag: 'wx' })
  chmodSync(git, 0o700)
  for (const name of ['ui-policy', 'browser-tests']) {
    const source = readFileSync(`.github/workflows/${name}.yml`, 'utf8')
    const block = /      - id: docs[\s\S]*?        run: \|\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]*:)/.exec(source)
    assert.ok(block, 'trusted classifier step must be present')
    const script = block[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
    const outputFile = join(dir, `${name}.output`)
    const output = execFileSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8', env: {
      PATH: `${bin}:${process.env.PATH}`, FIXTURE_CLASSIFIER: resolve('scripts/ci-docs-only.mjs'),
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_OUTPUT: outputFile,
    } })
    assert.match(output, /Retained trusted classifier: .*\.mjs/)
    assert.match(readFileSync(outputFile, 'utf8'), /docs_only=false/)
    writeFileSync(join(dir, `${name}.log`), output, { flag: 'wx' })
  }
})
