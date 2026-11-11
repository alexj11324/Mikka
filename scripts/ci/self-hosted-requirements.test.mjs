import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dependencyTestCommand, isSelfHostedBackendInput, verifyChange } from './self-hosted-requirements.mjs'

const path = 'lib/feature.ts'
const migration = 'drizzle/0100-upgrade.sql'
const check = (file, before, after, declarations = {}) =>
  verifyChange(file, before, after, declarations, file => file === 'tests/new.test.ts')
const local = { mode: 'built-in', environment: [], behavior: 'Uses the installation database.', test: 'tests/new.test.ts' }

test('only the verified PR test merge excludes changes already on its advanced base', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'mikka-selfhost-base-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const write = (path, value) => writeFileSync(join(cwd, path), value)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  mkdirSync(join(cwd, 'config'))
  mkdirSync(join(cwd, 'lib'))
  write('config/self-hosted-requirements.json', '{}')
  write('package.json', '{"scripts":{}}')
  write('lib/existing.ts', 'export const existing = true')
  git('add', '.')
  git('commit', '-qm', 'base recorded in event')
  const base = git('rev-parse', 'HEAD')
  git('switch', '-qc', 'feature')
  write('lib/feature.ts', 'export const feature = true')
  git('add', '.')
  git('commit', '-qm', 'PR capability')
  const head = git('rev-parse', 'HEAD')
  git('switch', '-q', 'main')
  write('lib/upstream.ts', 'export const upstream = true')
  git('add', '.')
  git('commit', '-qm', 'independent change on main')
  const advanced = git('rev-parse', 'HEAD')
  git('merge', '-q', '--no-ff', 'feature', '-m', 'test merge')
  const sha = git('rev-parse', 'HEAD')
  const script = fileURLToPath(new URL('./self-hosted-requirements.mjs', import.meta.url))
  function check(event, env = {}) {
    write('event.json', JSON.stringify(event))
    const child = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', env: {
      ...process.env, GITHUB_EVENT_PATH: join(cwd, 'event.json'), GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REF: 'refs/pull/41/merge', GITHUB_SHA: sha, ...env,
    } })
    assert.equal(child.status, 1, child.stderr)
    assert.match(child.stderr, /lib\/feature\.ts: declare/)
    return child.stderr.includes('lib/upstream.ts: declare')
  }
  const payload = (baseSha, headSha) => ({ number: 41, pull_request: { base: { sha: baseSha }, head: { sha: headSha } } })
  const event = payload(base, head)
  assert.equal(check(event), false)
  assert.equal(check(event, { GITHUB_SHA: advanced }), true)
  assert.equal(check(event, { GITHUB_REF: 'refs/pull/41/head' }), true)
  assert.equal(check(payload(base, advanced)), true)
  const divergent = git('commit-tree', base + '^{tree}', '-p', base, '-m', 'divergent event base')
  assert.equal(check(payload(divergent, head)), true)
  assert.equal(check({ before: base }, { GITHUB_EVENT_NAME: 'push' }), true)
  assert.equal(check({ merge_group: { base_sha: base } }, { GITHUB_EVENT_NAME: 'merge_group' }), true)
})

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
