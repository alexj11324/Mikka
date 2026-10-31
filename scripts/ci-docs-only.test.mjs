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
    'AGENTS.md',
    'README.zh-CN.md',
    'docs/design/glossary.md',
    'tasks/lessons.md',
    'LICENSE',
    '.github/pull_request_template.md',
  ]
  assert.equal(isDocsOnly(files), true)
  assert.equal(isDocsOnly(['AGENTS.md']), true)
  assert.equal(isDocsOnly(['AGENTS.md', 'docs/README.md']), true)
  assert.equal(isDocsOnly(['AGENTS.md', 'scripts/ci-docs-only.mjs']), false)
  assert.equal(isDocsOnly(['AGENTS.md'], true), false)
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
    'tasks/AGENTS.md',
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
  // Docs-only main pushes retain small status gates but skip heavy postsubmit jobs.
  // Missing or rewritten history must still take the full integration path.
  const changedCodeTree = root([oldDocs], false)
  const codeHead = git(['commit-tree', changedCodeTree, '-p', base, '-m', 'remove-code'])
  const unrelatedHead = git(['commit-tree', root([oldDocs]), '-m', 'unrelated-history'])
  for (const [name, before, after, expectedDocs, tier, performance] of [
    ['main-docs', base, docsHead, true, 'docs', 'false'],
    ['main-code', base, codeHead, false, 'main', 'false'],
    ['main-unknown', '0'.repeat(40), docsHead, false, 'full', 'true'],
    ['main-nonancestor', unrelatedHead, docsHead, false, 'full', 'true'],
  ]) {
    const eventFile = join(dir, `${name}-event.json`)
    record(`${name}-event.json`, { before, after })
    const output = execFileSync(process.execPath, [script], {
      cwd: dir, encoding: 'utf8', env: {
        ...env, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_PATH: eventFile, GITHUB_SHA: after,
      },
    })
    record(`${name}-result.json`, { output })
    assert.match(output, new RegExp(`docs_only=${expectedDocs}`), name)
    assert.match(output, new RegExp(`browser_tier=${tier}`), name)
    assert.match(output, new RegExp(`performance=${performance}`), name)
  }
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


test('the workflow-extracted trusted classifier executes as an ES module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-gate-loader-retained-'))
  console.log(`Retained docs gate loader evidence: ${dir}`)
  for (const file of ['.github/workflows/ui-policy.yml', '.github/workflows/browser-tests.yml']) {
    const workflow = readFileSync(file, 'utf8')
    const allocation = workflow.match(/trusted="\$\((mktemp[^\n]*)\)"/)
    assert.ok(allocation, file)
    const env = { PATH: process.env.PATH, TMPDIR: dir, HOME: process.env.HOME ?? '' }
    const extracted = execFileSync('bash', ['-ceu', allocation[1]], { env, encoding: 'utf8' }).trim()
    writeFileSync(extracted, readFileSync('scripts/ci-docs-only.mjs'))
    const output = execFileSync(process.execPath, [extracted, '--base', 'missing-base', '--head', 'missing-head'], { env, encoding: 'utf8' })
    assert.match(output, /docs_only=false/, file)
  }
})

test('trusted workflow classifier executes as an ES module from its retained temporary file', () => {
  for (const file of ['.github/workflows/ui-policy.yml', '.github/workflows/browser-tests.yml']) {
    const workflow = readFileSync(file, 'utf8')
    const command = /trusted="\$\((mktemp[^)]+)\)"/.exec(workflow)?.[1]
    assert.equal(command, 'mktemp --suffix=.mjs')
    const trusted = execFileSync('mktemp', ['--suffix=.mjs'], { encoding: 'utf8' }).trim()
    console.log(`Retained trusted classifier fixture: ${trusted}`)
    writeFileSync(trusted, readFileSync('scripts/ci-docs-only.mjs', 'utf8'))
    const output = execFileSync(process.execPath, [trusted], {
      encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' },
    })
    assert.match(output, /docs_only=false/)
  }
})

test('all required gates reject failed classification and skipped full jobs', () => {
  for (const file of ['.github/workflows/ui-policy.yml']) {
    const source = readFileSync(file, 'utf8')
    const blocks = [...source.matchAll(/      - name: Require the full suite unless only documentation changed\n([\s\S]*?)(?=\n  [a-z][a-z-]*:|$)/g)]
    assert.equal(blocks.length, file.includes('ui-policy') ? 2 : 1)
    for (const [, block] of blocks) {
      const script = block.split('        run: |\n')[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
      const result = (changes, docs, full) => {
        try { execFileSync('bash', ['--noprofile', '--norc', '-e', '-c', script], { env: { PATH: process.env.PATH, CHANGES_RESULT: changes, DOCS_ONLY: docs, FULL_RESULT: full }, stdio: 'ignore' }); return true } catch { return false }
      }
      assert.equal(result('failure', 'true', 'skipped'), false)
      assert.equal(result('success', 'false', 'skipped'), false)
      assert.equal(result('success', 'false', 'failure'), false)
      assert.equal(result('success', 'false', 'success'), true)
      assert.equal(result('success', 'true', 'skipped'), true)
    }
  }
})

test('each actual workflow temp-file command produces a classifier Node can load outside the package', () => {
  for (const file of ['.github/workflows/ui-policy.yml', '.github/workflows/browser-tests.yml']) {
    const source = readFileSync(file, 'utf8')
    const command = source.match(/^          (trusted="\$\(mktemp[^\n]*\)")$/m)?.[1]
    assert.ok(command, 'Exercise the actual workflow temporary-file command')
    const dir = mkdtempSync(join(tmpdir(), 'docs-gate-module-retained-'))
    const env = { PATH: process.env.PATH, TMPDIR: dir, HOME: process.env.HOME ?? '' }
    const trusted = execFileSync('bash', ['-e', '-c', command + '; printf "%s" "$trusted"'], { cwd: dir, env, encoding: 'utf8' })
    assert.equal(resolve(trusted, '..'), dir, 'Fixture must belong to this new temporary directory')
    writeFileSync(trusted, readFileSync('scripts/ci-docs-only.mjs'))
    const output = execFileSync(process.execPath, [trusted], { cwd: dir, env: { ...env, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }, encoding: 'utf8' })
    assert.match(output, /docs_only=false \(no comparable range\)/)
    assert.match(output, /browser_tier=full; performance=true; specs=\[\]/)
    console.log(`Retained workflow module-loader evidence: ${trusted}`)
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
    const output = execFileSync('bash', ['--noprofile', '--norc', '-e', '-c', script], { cwd: dir, encoding: 'utf8', env: {
      PATH: `${bin}:${process.env.PATH}`, FIXTURE_CLASSIFIER: resolve('scripts/ci-docs-only.mjs'),
      TMPDIR: dir,
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_OUTPUT: outputFile,
    } })
    assert.match(output, /Retained trusted classifier: .*\.mjs/)
    assert.match(readFileSync(outputFile, 'utf8'), /docs_only=false/)
    writeFileSync(join(dir, `${name}.log`), output, { flag: 'wx' })
  }
})

test('actual workflow classifier launches trusted ESM from its retained temporary file', () => {
  for (const file of ['.github/workflows/ui-policy.yml', '.github/workflows/browser-tests.yml']) {
    const source = readFileSync(file, 'utf8')
    const block = source.match(/      - id: docs[\s\S]*?        run: \|\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]*:)/)?.[1]
    assert.ok(block, file)
    const script = block.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
    const dir = mkdtempSync(join(tmpdir(), 'docs-workflow-retained-'))
    const repo = join(dir, 'repository'), temporary = join(dir, 'temporary'), template = join(dir, 'empty-template')
    for (const path of [repo, temporary, template, join(repo, 'scripts')]) mkdirSync(path)
    console.log(`Retained workflow classifier evidence: ${dir}`)
    const env = { PATH: process.env.PATH, TMPDIR: temporary, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }
    const git = args => execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git(['init', '--initial-branch=main', '--template=' + template])
    writeFileSync(join(repo, 'scripts/ci-docs-only.mjs'), readFileSync('scripts/ci-docs-only.mjs'))
    git(['add', '.']); git(['commit', '-m', 'trusted classifier'])
    const base = git(['rev-parse', 'HEAD'])
    git(['remote', 'add', 'origin', repo])
    git(['switch', '-c', 'candidate'])
    writeFileSync(join(repo, 'code.js'), 'export const changed = true\n')
    git(['add', '.']); git(['commit', '-m', 'code change'])
    const head = git(['rev-parse', 'HEAD']), event = join(dir, 'event.json')
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }))
    const output = execFileSync('bash', ['--noprofile', '--norc', '-e', '-c', script], { cwd: repo, env: { ...env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    writeFileSync(join(dir, 'result.txt'), output)
    assert.match(output, /docs_only=false/)
    assert.doesNotMatch(output, /classifier (?:differs|is not on main)/)
  }
})

test('the trusted classifier runs as a copied .mjs entry point', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trusted-docs-entry-'))
  const entry = join(dir, 'classifier.mjs')
  writeFileSync(entry, readFileSync(new URL('./ci-docs-only.mjs', import.meta.url)))
  const output = execFileSync(process.execPath, [entry, '--base', 'HEAD', '--head', 'HEAD'], {
    cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' },
  })
  assert.match(output, /docs_only=false/)
})

test('the actual workflow bootstrap executes its trusted temporary ESM module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-gate-bootstrap-retained-'))
  console.log(`Retained workflow bootstrap evidence: ${dir}`)
  const env = {
    PATH: process.env.PATH, TMPDIR: dir,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  }
  const git = args => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim()
  mkdirSync(join(dir, 'empty-template'))
  git(['init', '--initial-branch=main', '--template=empty-template'])
  git(['config', 'gc.auto', '0'])
  git(['config', 'maintenance.auto', 'false'])
  mkdirSync(join(dir, 'scripts'))
  writeFileSync(join(dir, 'scripts/ci-docs-only.mjs'), readFileSync('scripts/ci-docs-only.mjs'), { flag: 'wx' })
  writeFileSync(join(dir, 'README.md'), 'base\n', { flag: 'wx' })
  git(['add', '.'])
  git(['commit', '-m', 'base'])
  const base = git(['rev-parse', 'HEAD'])
  // The remote is this new fixture itself; the real bootstrap cannot fetch the
  // network or access a user's repository/credentials.
  git(['remote', 'add', 'origin', dir])
  git(['switch', '-c', 'candidate'])
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs/new.md'), 'new documentation\n', { flag: 'wx' })
  git(['add', 'docs/new.md'])
  git(['commit', '-m', 'docs change'])
  const docs = git(['rev-parse', 'HEAD'])
  writeFileSync(join(dir, 'code.js'), 'export const fixture = true\n', { flag: 'wx' })
  git(['add', 'code.js'])
  git(['commit', '-m', 'code change'])
  const code = git(['rev-parse', 'HEAD'])
  for (const file of ['.github/workflows/ui-policy.yml', '.github/workflows/browser-tests.yml']) {
    const workflow = readFileSync(file, 'utf8')
    const block = workflow.split('      - id: docs\n')[1]?.split('        run: |\n')[1]
    assert.ok(block, file)
    const body = []
    for (const line of block.split('\n')) {
      if (line.trim() && !line.startsWith('          ')) break
      body.push(line.startsWith('          ') ? line.slice(10) : line)
    }
    const script = body.join('\n')
    for (const [name, head, expected] of [['docs', docs, true], ['code', code, false]]) {
      const prefix = `${file.includes('ui-policy') ? 'ui' : 'browser'}-${name}`
      const event = join(dir, `${prefix}-event.json`), output = join(dir, `${prefix}-output`)
      writeFileSync(event, JSON.stringify({ before: base, after: head }), { flag: 'wx' })
      writeFileSync(output, '', { flag: 'wx' })
      const stdout = execFileSync('bash', ['--noprofile', '--norc', '-e', '-c', script], {
        cwd: dir, encoding: 'utf8',
        env: { ...env, GITHUB_EVENT_NAME: 'push', GITHUB_SHA: head, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output },
      })
      writeFileSync(join(dir, `${prefix}-result.json`), JSON.stringify({ base, head, expected, stdout }), { flag: 'wx' })
      assert.match(readFileSync(output, 'utf8'), new RegExp(`docs_only=${expected}`), `${file}: ${name}`)
    }
  }
})

test('blocking CI checks synthetic PR merge candidates once and preserves every main run', () => {
  const source = readFileSync('.github/workflows/ui-policy.yml', 'utf8')
  const events = source.split('\npermissions:')[0]
  assert.match(events, /on:\n  push:\n    branches: \[main\]\n  pull_request:\n  merge_group:/)
  assert.doesNotMatch(events, /branches-ignore:/)
  assert.doesNotMatch(source, /github\.event\.pull_request\.head\.repo\.full_name != github\.repository/)
  assert.match(source, /name: UI policy \(strict\)/)
  assert.match(source, /name: Production build and browser interactions\n/)
  assert.match(source, /if: github\.event_name != 'pull_request'/)
  for (const workflow of ['ui-policy.yml', 'browser-tests.yml']) {
    const text = readFileSync(`.github/workflows/${workflow}`, 'utf8')
    assert.match(text, /github\.ref == 'refs\/heads\/main' && format\('-\{0\}', github\.run_id\)/)
    assert.match(text, /cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}/)
  }
  const browser = readFileSync('.github/workflows/browser-tests.yml', 'utf8')
  assert.match(browser, /name: Browser tests \(before merge\)/)
  assert.match(browser, /push:\n    branches: \[main\]/)
})
