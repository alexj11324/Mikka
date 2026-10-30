import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRunSecretsEnvironment as resolve } from './run-environment'

const cloud = (runBaseBranch: unknown, trustedDefaultBranch: unknown, override?: unknown) =>
  resolve({ deviceKind: 'cloud', runBaseBranch: runBaseBranch as string | null, trustedDefaultBranch: trustedDefaultBranch as string | null, override })
const production = { environment: 'production', rejected: false }
const preview = { environment: 'preview', rejected: false }

test('4e3: production only when a trusted default branch equals the run branch exactly', () => {
  assert.deepEqual(cloud('main', 'main'), production)
  assert.deepEqual(cloud('release/1', 'release/1'), production)
  assert.deepEqual(cloud(' main ', 'main'), production, 'trimmed run branch')
  assert.deepEqual(cloud('main', '  main\t'), production, 'trimmed trusted default (catches dropping trim)')
  assert.deepEqual(cloud('feature/x', 'main'), preview)
  assert.deepEqual(cloud('Main', 'main'), preview, 'case-sensitive')
})

test('4e3: no trusted source is always preview, including pass-throughs of the run branch or the schema default', () => {
  // The claim route has no trusted default-branch source yet and passes null; device_repos.baseBranch is
  // written from the run itself on the cloud path and defaults to 'main', so it is never a trusted source.
  assert.deepEqual(cloud('feature/x', null), preview, '(feature/x, no source)')
  assert.deepEqual(cloud('main', null), preview, "the 'main' default without a source")
  assert.deepEqual(cloud(null, null), preview, '(null, null)')
  assert.deepEqual(cloud(null, ''), preview, "(null, '')")
  assert.deepEqual(cloud('  ', null), preview, "('  ', null)")
  assert.deepEqual(cloud('', ''), preview, "('', '')")
  assert.deepEqual(cloud('  ', '  '), preview, 'whitespace on both sides never matches')
  assert.deepEqual(cloud(null, 'main'), preview, 'a null run branch is not "the remote default"')
  assert.deepEqual(cloud('main', '   '), preview)
  assert.deepEqual(cloud(42, 42), preview, 'non-string is unreadable')
  assert.deepEqual(cloud(undefined, undefined), preview)
})

test('4e3: local runs are development', () => {
  assert.deepEqual(resolve({ deviceKind: 'local', runBaseBranch: 'main', trustedDefaultBranch: 'main' }), { environment: 'development', rejected: false })
})

test('4e3: every override request is rejected (member, admin or forged), cloud or local', () => {
  for (const override of ['production', 'preview', 'PRODUCTION', 'development', '', 0, {}]) {
    assert.deepEqual(cloud('main', 'main', override), { environment: 'preview', rejected: true }, `cloud override ${JSON.stringify(override)}`)
    assert.deepEqual(resolve({ deviceKind: 'local', runBaseBranch: 'main', trustedDefaultBranch: 'main', override }), { environment: 'development', rejected: true }, `local override ${JSON.stringify(override)}`)
  }
  assert.deepEqual(cloud('main', 'main', null), production)
})
