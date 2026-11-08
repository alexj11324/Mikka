import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir as systemTmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { hasUnsafeModes, isDocsOnly } from './ci-docs-only.mjs'

const tmpdir = () => realpathSync(systemTmpdir())
function copyTrustedClassifier(entry) {
  writeFileSync(entry, readFileSync(new URL('./ci-docs-only.mjs', import.meta.url)))
}

test('approved documentation paths are documentation-only', () => {
  const files = [
    'README.md',
    'AGENTS.md',
    'README.zh-CN.md',
    'docs/design/glossary.md',
    'tasks/lessons.md',
    'LICENSE',
    '.github/pull_request_template.md',
    'docs/assets/architecture-light.svg',
    'scripts/generate-diagrams.mjs',
    'scripts/diagram-svg.mjs',
    'CONTRIBUTING.md',
    'REVIEW.md',
    '.github/workflows/README.md',
    'packages/subscription-worker/README.md',
    'apps/mobile/README.md',
    'agents/README.md',
    'apps/mobile/DESIGN.md',
    'packages/daemon/THIRD_PARTY_NOTICES.md',
    'scripts/acceptance/run-observability.md',
    '.claude/skills/README.md',
    '.claude/skills/tdd/SKILL.md',
    '.claude/skills/tdd/agents/openai.yaml',
    'docs/acceptance/evidence/run/screen.png',
    'docs/design/research/assets/secrets/01.png',
    'docs/screenshots/flow.mp4',
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
    'agents/research-example/instructions.md',
    'packages/daemon/src/THIRD_PARTY_NOTICES.md',
    'scripts/acceptance/run-observability.mjs',
    'public/brand/mikka-icon-light.svg',
    'docs/tool.mjs',
    'tasks/migration.sql',
    'docs/generated.js',
    'docs/assets/nested/image.svg',
    'docs/assets/photo.png',
    'docs/AGENTS.md',
    'tasks/AGENTS.md',
    'scripts/release/workspace-sbom.mjs',
    'packages/daemon/src/README.md',
    'packages/daemon/package.json',
    '.claude/skills/tdd/run.sh',
    '.claude/skills/AGENTS.md',
    '.claude/settings.json',
    '.github/workflows/README.yml',
    'docs/integration/migration-manifest-20261029.json',
    'docs/factory/schema-proposals/195-incidents.sql',
    'docs/design/research/assets/secrets/screens.html',
    'docs/assets/photo.png',
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
  for (const [name, before, after, expectedDocs] of [
    ['main-docs', base, docsHead, true],
    ['main-code', base, codeHead, false],
    ['main-unknown', '0'.repeat(40), docsHead, false],
    ['main-nonancestor', unrelatedHead, docsHead, false],
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


test('the trusted classifier runs as a copied .mjs entry point', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trusted-docs-entry-'))
  const entry = join(dir, 'classifier.mjs')
  copyTrustedClassifier(entry)
  const output = execFileSync(process.execPath, [entry, '--base', 'HEAD', '--head', 'HEAD'], {
    cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' },
  })
  assert.match(output, /docs_only=false/)
})

test('a trusted stdin wrapper can import the paired classifier without running its entry point', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trusted-docs-stdin-')), entry = join(dir, 'ci-docs-only.mjs')
  copyTrustedClassifier(entry)
  const output = execFileSync(process.execPath, ['--input-type=module', '-', entry], {
    encoding: 'utf8', input: "import { pathToFileURL } from 'node:url'; const policy = await import(pathToFileURL(process.argv[2]).href); console.log(typeof policy.isDocsOnly)",
  })
  assert.equal(output.trim(), 'function')
})

test('blocking CI checks synthetic PR merge candidates once and preserves every main run', () => {
  const source = readFileSync('.github/workflows/ui-policy.yml', 'utf8')
  const events = source.split('\npermissions:')[0]
  assert.match(events, /on:\n  push:\n    branches: \[main\]\n  pull_request:\n  merge_group:/)
  assert.doesNotMatch(events, /branches-ignore:/)
  assert.doesNotMatch(source, /github\.event\.pull_request\.head\.repo\.full_name != github\.repository/)
  assert.match(source, /name: UI policy \(strict\)/)
  assert.match(source, /name: Production build and browser interactions\n/)
  assert.doesNotMatch(source, /run: pnpm build\n/)
  for (const workflow of ['ui-policy.yml']) {
    const text = readFileSync(`.github/workflows/${workflow}`, 'utf8')
    assert.match(text, /github\.ref == 'refs\/heads\/main' && format\('-\{0\}', github\.run_id\)/)
    assert.match(text, /cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}/)
  }
  assert.match(readFileSync('.github/workflows/browser-gate.yml', 'utf8'), /name: Browser tests \(before merge\)\n/)
})


test('CI partitions DB suites across isolated jobs and requires source and daemon lanes', () => {
  const source = readFileSync('.github/workflows/ui-policy.yml', 'utf8')
  const job = name => source.split(`\n  ${name}:\n`)[1].split(/\n  [a-z][a-z-]*:\n/)[0]
  const database = job('browser-tests-full')
  assert.match(database, /fail-fast: false/)
  assert(database.includes('matrix: ${{ fromJSON(needs.changes.outputs.db_matrix) }}'))
  assert(database.includes('DB_TEST_SHARD: ${{ matrix.shard }}'))
  assert(database.includes('DB_TEST_SELECTED: ${{ needs.changes.outputs.db_suites }}'))
  assert.match(database, /services:\n      postgres:\n        image: postgres:17/)
  assert(database.includes('name: pr13-http-cli-approval-${{ github.sha }}-${{ strategy.job-index }}'))
  assert(!database.includes('run: pnpm build'))
  assert(Object.values(JSON.parse(readFileSync('scripts/ci/tasks.json'))).some(t => t.kind === 'integration' && t.command === 'pnpm test:issues'))
  assert(!job('ui-policy-full').includes('run: pnpm test:issues'))
  const checks = job('source-checks')
  for (const command of ['pnpm lint:code', 'node apps/api/scripts/generate-routes.mjs --check', 'pnpm typecheck', 'pnpm --filter @mikka/protocol typecheck', 'pnpm --filter @mikka/mobile typecheck']) assert(checks.includes(`run: ${command}\n`), command)
  const daemon = job('daemon-checks')
  // Runs use no sandbox (decision 2026-11-01-2335): the daemon lane runs its unit suite, no sandbox acceptance.
  assert(daemon.includes('pnpm --filter @mikka/daemon exec vitest run'))
  assert(!daemon.includes('MIKKA_SANDBOX_ACCEPTANCE'))
  assert(daemon.includes('pnpm --filter @mikka/daemon test:package'))
  const gate = job('ui-policy')
  for (const name of ['changes','ui-policy-full','ui-policy-integrations','source-checks','daemon-checks','image-checks','desktop-checks','analytics-checks']) assert(gate.includes(name))
  for (const name of ['ui-policy-full', 'ui-policy-integrations', 'source-checks', 'daemon-checks']) assert(gate.includes(`needs.${name}.result`))
})

test('integration branches take the full tier under both the integration/ and the older integrate/ prefix', () => {
  const subagents = readFileSync('.github/workflows/subagents.yml', 'utf8')
  assert.match(subagents, /branches: \[[^\]]*'integration\/\*\*'[^\]]*'integrate\/\*\*'\]/)
})
