import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { dependencyTestCommand, isSelfHostedBackendInput, verifyChange } from './self-hosted-requirements.mjs'

const path = 'lib/feature.ts'
const migration = 'drizzle/0100-upgrade.sql'
const check = (file, before, after, declarations = {}) =>
  verifyChange(file, before, after, declarations, file => file === 'tests/new.test.ts')
const local = { mode: 'built-in', environment: [], behavior: 'Uses the installation database.', test: 'tests/new.test.ts' }
test('added backend capability and changed migrations need a verified self-hosted declaration', () => {
  for (const file of [path, migration]) {
    assert.match(check(file, null, 'new')[0], /declare/)
    assert.deepEqual(check(file, null, 'new', { [file]: local }), [])
    assert.match(check(file, null, 'new', { [file]: { ...local, test: 'missing' } })[0], /acceptance test/)
  }
  assert.match(check(path, 'const a = 1', 'export function route() {}')[0], /declare/)
  assert.deepEqual(check(path, 'const a = 1', 'const a = 2'), [])
})
test('new secret references and hard-coded hosted origins in existing server files are detected', () => {
  const source = "const a = env['SERVICE_KEY']"
  assert.match(check(path, '', source, { [path]: local })[0], /SERVICE_KEY/)
  assert.deepEqual(check(path, '', source, { [path]: { ...local, mode: 'operator-configured', environment: ['SERVICE_KEY'] } }), [])
  assert.match(check(path, '', "const base = 'https://app.aspectlylabs.com/'", { [path]: local })[0], /hard-coded hosted origin/)
})

test('Nx and the declaration checker share the backend and migration path classifier', () => {
  for (const path of ['app/v1/models/route.ts', 'app/actions/create.ts', 'apps/api/plugins/service.ts',
    'apps/eve/src/worker.ts', 'packages/core/new.ts', 'services/backend/new.ts', 'workflows/run.ts', migration]) {
    assert.equal(isSelfHostedBackendInput(path), true, path)
    assert.match(check(path, null, '')[0], /declare/, path)
  }
  for (const path of ['components/ui/button.tsx', 'lib/feature.test.ts', 'docs/new.md']) {
    assert.equal(isSelfHostedBackendInput(path), false, path)
  }
})

test('every selected declaration maps to an executable Node test or matching repository suite', () => {
  assert.deepEqual(dependencyTestCommand({ test: 'scripts/example.test.mjs' }, {}), [process.execPath, '--test', 'scripts/example.test.mjs'])
  const spec = { test: 'lib/demo.test.ts', suite: 'test:demo' }
  assert.deepEqual(dependencyTestCommand(spec, { 'test:demo': 'node --import tsx --test lib/demo.test.ts lib/other.test.ts' }),
    [process.execPath, '--import', 'tsx', '--test', 'lib/demo.test.ts'])
  const mobile = 'node --test lib/a.test.mjs && TSX_TSCONFIG_PATH=apps/mobile/tsconfig.json node --import tsx --test lib/demo.test.ts'
  assert.deepEqual(dependencyTestCommand(spec, { 'test:demo': mobile }),
    ['env', 'TSX_TSCONFIG_PATH=apps/mobile/tsconfig.json', process.execPath, '--import', 'tsx', '--test', 'lib/demo.test.ts'])
  assert.deepEqual(dependencyTestCommand(spec, { 'test:demo': 'node scripts/custom-runner.mjs lib/demo.test.ts' }),
    ['pnpm', 'run', 'test:demo'])
  assert.deepEqual(dependencyTestCommand(spec, { 'test:demo': 'npm run build && node --test lib/demo.test.ts' }),
    ['pnpm', 'run', 'test:demo'])
  const database = { ...spec, test: 'lib/demo.db.test.ts' }
  assert.deepEqual(dependencyTestCommand(database, { 'test:demo': 'node --import tsx --test lib/demo.db.test.ts' }),
    [process.execPath, '--import', 'tsx', '--test-force-exit', '--test', database.test])
  assert.throws(() => dependencyTestCommand(spec, { 'test:demo': 'node other.ts' }))
  assert.throws(() => dependencyTestCommand({ ...spec, suite: 'postinstall' }, { postinstall: spec.test }))
})

test('the self-hosted product RPC declaration runs its acceptance file with the server loaders', () => {
  const declarations = JSON.parse(readFileSync(new URL('../../config/self-hosted-requirements.json', import.meta.url), 'utf8'))
  const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(dependencyTestCommand(declarations['lib/eve/product-rpc.ts'], scripts),
    [process.execPath, '--experimental-test-module-mocks', '--import', './scripts/server-test.mjs', '--import', 'tsx', '--test', 'lib/eve/product-tool.test.ts'])
})


function gitHistory(t) {
  const root = mkdtempSync(join(tmpdir(), 'mikka-self-hosted-range-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'CI fixture', GIT_AUTHOR_EMAIL: 'ci@example.invalid',
    GIT_COMMITTER_NAME: 'CI fixture', GIT_COMMITTER_EMAIL: 'ci@example.invalid' }
  // Declared compatibility commands must execute outside the parent Node test context.
  delete env.NODE_TEST_CONTEXT
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (file, source) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  const commit = message => {
    git('add', '.')
    git('commit', '-qm', message)
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q', '--initial-branch=main')
  write('package.json', JSON.stringify({ type: 'module', scripts: {} }))
  const declarations = {
    'lib/feature.ts': { ...local, test: 'scripts/feature.test.mjs' },
    'lib/unrelated.ts': { ...local, test: 'scripts/unrelated.db.test.mjs' },
    'lib/untouched.ts': { ...local, test: 'scripts/untouched.test.mjs' },
  }
  write('config/self-hosted-requirements.json', JSON.stringify(declarations))
  for (const [name, file] of [['feature', 'scripts/feature.test.mjs'], ['unrelated-db', 'scripts/unrelated.db.test.mjs'], ['untouched', 'scripts/untouched.test.mjs']]) {
    write(file, `import { appendFileSync } from 'node:fs'; appendFileSync('ran-compatibility.txt', ${JSON.stringify(name + '\n')})`)
  }
  write('lib/feature.ts', 'const value = 0\n')
  write('lib/unrelated.ts', 'const value = 0\n')
  write('lib/untouched.ts', 'const value = 0\n')
  write('.github/workflows/runtime.yml', 'name: Original\n')
  const base = commit('initial installation')
  const run = (event, flag, overrides = {}) => {
    const eventPath = join(root, 'event.json')
    writeFileSync(eventPath, JSON.stringify(event))
    return execFileSync(process.execPath, [fileURLToPath(new URL('./self-hosted-requirements.mjs', import.meta.url)), ...(flag ? [flag] : [])], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge',
        GITHUB_SHA: git('rev-parse', 'HEAD'), GITHUB_REF_TYPE: 'branch', ...overrides },
    }).trim()
  }
  const executed = () => existsSync(join(root, 'ran-compatibility.txt'))
    ? readFileSync(join(root, 'ran-compatibility.txt'), 'utf8').trim().split('\n').sort() : []
  return { git, write, commit, run, executed, base, declarations }
}

const pullRequest = (base, head) => ({ number: 7, pull_request: { base: { sha: base }, head: { sha: head } } })

function advancedMainMerge(t) {
  const f = gitHistory(t)
  f.git('switch', '-qc', 'pr')
  f.write('.github/workflows/runtime.yml', 'name: PR workflow change\n')
  const head = f.commit('workflow-only PR')
  f.git('switch', '-q', 'main')
  f.declarations['lib/unrelated.ts'].behavior = 'Unrelated main declaration update.'
  f.write('config/self-hosted-requirements.json', JSON.stringify(f.declarations))
  const testedBase = f.commit('main advances after event snapshot')
  f.git('merge', '--no-ff', '-qm', 'tested PR merge', 'pr')
  return { ...f, event: pullRequest(f.base, head), testedBase }
}

test('tested PR merge excludes declarations added by main after the event snapshot', t => {
  const f = advancedMainMerge(t)
  assert.equal(f.run(f.event, '--needs-db'), 'false')
  assert.match(f.run(f.event, '--run-tests'), new RegExp(f.testedBase + '$'))
  assert.deepEqual(f.executed(), [])
})


for (const checkout of ['tested merge', 'plain PR head']) {
  test(`${checkout} includes every commit in a multi-commit PR`, t => {
    const f = gitHistory(t)
    f.git('switch', '-qc', 'pr')
    f.write('lib/feature.ts', 'export const feature = 1\n')
    f.commit('first PR capability')
    f.write('lib/unrelated.ts', 'export const unrelated = 1\n')
    const head = f.commit('second PR capability')
    if (checkout === 'tested merge') {
      f.git('switch', '-q', 'main')
      f.git('merge', '--no-ff', '-qm', 'tested PR merge', 'pr')
    }
    const event = pullRequest(f.base, head)
    assert.equal(f.run(event, '--needs-db'), 'true')
    assert.match(f.run(event, '--run-tests'), new RegExp(f.base + '$'))
    assert.deepEqual(f.executed(), ['feature', 'unrelated-db'])
  })

  test(`${checkout} selects the full inventory for a genuine PR declaration change`, t => {
    const f = gitHistory(t)
    f.git('switch', '-qc', 'pr')
    f.declarations['lib/feature.ts'].behavior = 'An explicitly changed PR dependency behavior.'
    f.write('config/self-hosted-requirements.json', JSON.stringify(f.declarations))
    f.commit('PR changes a requirement declaration')
    f.write('.github/workflows/runtime.yml', 'name: Last PR workflow change\n')
    const head = f.commit('later PR workflow commit')
    if (checkout === 'tested merge') {
      f.git('switch', '-q', 'main')
      f.git('merge', '--no-ff', '-qm', 'tested PR merge', 'pr')
    }
    const event = pullRequest(f.base, head)
    assert.equal(f.run(event, '--needs-db'), 'true')
    f.run(event, '--run-tests')
    assert.deepEqual(f.executed(), ['feature', 'unrelated-db', 'untouched'])
  })
}

for (const context of ['different checkout SHA', 'different PR merge ref', 'different PR head', 'missing runner SHA']) {
  test(`a merge with ${context} keeps the event-base selection`, t => {
    const f = advancedMainMerge(t)
    const overrides = {}
    if (context === 'different checkout SHA') overrides.GITHUB_SHA = f.event.pull_request.head.sha
    if (context === 'different PR merge ref') overrides.GITHUB_REF = 'refs/pull/8/merge'
    if (context === 'different PR head') f.event.pull_request.head.sha = f.base
    if (context === 'missing runner SHA') overrides.GITHUB_SHA = ''
    assert.equal(f.run(f.event, '--needs-db', overrides), 'true')
    assert.match(f.run(f.event, '--run-tests', overrides), new RegExp(f.base + '$'))
    assert.deepEqual(f.executed(), ['feature', 'unrelated-db', 'untouched'])
  })
}

test('a push checks every commit since event.before', t => {
  const f = gitHistory(t)
  f.write('lib/feature.ts', 'export const feature = 1\n')
  f.commit('first pushed capability')
  f.write('.github/workflows/runtime.yml', 'name: Later workflow change\n')
  const head = f.commit('second pushed commit')
  const event = { before: f.base, after: head }
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }
  assert.equal(f.run(event, '--needs-db', env), 'false')
  assert.match(f.run(event, '--run-tests', env), new RegExp(f.base + '$'))
  assert.deepEqual(f.executed(), ['feature'])
})

test('tag builds keep the full inventory, including a zero push predecessor', t => {
  const f = gitHistory(t)
  f.write('.github/workflows/runtime.yml', 'name: Tag workflow\n')
  const head = f.commit('tagged revision')
  f.git('tag', 'v1.0.0')
  const event = { before: '0'.repeat(40), after: head }
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.0.0', GITHUB_REF_TYPE: 'tag' }
  assert.equal(f.run(event, '--needs-db', env), 'true')
  f.run(event, '--run-tests', env)
  assert.deepEqual(f.executed(), ['feature', 'unrelated-db', 'untouched'])
})

test('a merge group checks its whole declared range across queued merges', t => {
  const f = gitHistory(t)
  f.git('switch', '-qc', 'first-pr')
  f.declarations['lib/feature.ts'].behavior = 'The first queued PR changes a declaration.'
  f.write('config/self-hosted-requirements.json', JSON.stringify(f.declarations))
  f.commit('first queued PR')
  f.git('switch', '-qc', 'second-pr', f.base)
  f.write('.github/workflows/runtime.yml', 'name: Second queued PR\n')
  f.commit('second queued PR')
  f.git('switch', '-qc', 'queue', f.base)
  f.git('merge', '--no-ff', '-qm', 'first queued merge', 'first-pr')
  f.git('merge', '--no-ff', '-qm', 'tested queued merge', 'second-pr')
  const event = { merge_group: { base_sha: f.base, head_sha: f.git('rev-parse', 'HEAD') } }
  const env = { GITHUB_EVENT_NAME: 'merge_group', GITHUB_REF: 'refs/heads/gh-readonly-queue/main/group' }
  assert.equal(f.run(event, '--needs-db', env), 'true')
  assert.match(f.run(event, '--run-tests', env), new RegExp(f.base + '$'))
  assert.deepEqual(f.executed(), ['feature', 'unrelated-db', 'untouched'])
})

test('the authenticated merge comparison still rejects an undeclared backend capability', t => {
  const f = gitHistory(t)
  f.git('switch', '-qc', 'pr')
  f.write('lib/undeclared.ts', 'export const undeclared = 1\n')
  const head = f.commit('PR adds an undeclared capability')
  f.git('switch', '-q', 'main')
  f.git('merge', '--no-ff', '-qm', 'tested PR merge', 'pr')
  assert.throws(() => f.run(pullRequest(f.base, head)), /declare self-hosted dependencies/)
})
