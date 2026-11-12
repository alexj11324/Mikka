import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
