import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { assertInputCoverage, buildContexts, readBuildInputs, releaseManifest, serviceDigest, serviceNames, validateHistoricalReleaseManifest, validateReleaseManifest } from './service-builds.mjs'
import { migrationRoots, migrationToolchain } from './migration-inputs.mjs'
import { planServiceRelease } from './service-diff.mjs'

const firstSource = 'a'.repeat(40), secondSource = 'b'.repeat(40)
const digest = value => 'sha256:' + value.repeat(64)
const build = { runId: '101', runAttempt: '1', artifactId: '201', workflow: 'service-images.yml' }

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-service-inputs-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' })
  const put = async (path, value) => { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), value) }
  const services = Object.fromEntries(serviceNames.map(name => [name, { kind: ['web', 'world'].includes(name) ? 'worker' : 'container',
    groups: ['shared'], paths: [name + '/**'], entrypoints: [name + '/index.mjs'], ...(name === 'web' ? { overlay: true } : {}) }]))
  const inputs = { version: 1, exclude: ['**/*.test.mjs'], groups: { shared: ['shared/**'] }, services, migrations: ['drizzle/*.sql'] }
  await put('config/service-build-inputs.json', JSON.stringify(inputs))
  await put('shared/value.mjs', 'export const value = 1\n')
  for (const name of serviceNames) await put(name + '/index.mjs', "export { value } from '../shared/value.mjs'\n")
  await put('drizzle/202611200001_add_column.sql', 'ALTER TABLE example ADD COLUMN label text;\n')
  await put('scripts/migrate.mjs', "import './migration-helper.mjs'\nawait import('./migration-backfill.mjs')\nthrow new Error('Candidate migration code must not be evaluated')\n")
  await put('scripts/migration-helper.mjs', "export { value } from './migration-nested.mjs'\n")
  await put('scripts/migration-nested.mjs', 'export const value = 1\n')
  await put('scripts/migration-backfill.mjs', 'export const backfill = 1\n')
  await put('scripts/check-migrations.mjs', 'export const checkMigrations = () => []\n')
  await put('scripts/migration-steps.mjs', 'export const headerLines = () => []\n')
  await put('.node-version', '24\n')
  await put('package.json', '{"private":true}\n')
  await put('pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
  await put('pnpm-workspace.yaml', 'packages: []\n')
  git(['init', '--quiet']); git(['add', '.'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'initial inputs'])
  return { directory, put, git, inputs }
}

function plan(contexts = {}) {
  return { version: 1, sourceCommit: firstSource, overlayCommit: firstSource,
    services: Object.fromEntries(serviceNames.map(name => [name, { kind: ['web', 'world'].includes(name) ? 'worker' : 'container', contextDigest: contexts[name] ?? digest('1') }])),
    migrations: { version: 2, contextDigest: digest('2'), files: ['drizzle/202611200001_add_column.sql'],
      execution: { entrypoint: 'scripts/migrate.mjs', contextDigest: digest('6'), files: [...migrationRoots, ...migrationToolchain].sort() } } }
}

function publications(context) {
  return Object.fromEntries(serviceNames.map(name => [name, { ...context.services[name], sourceCommit: context.sourceCommit,
    overlayCommit: ['api', 'web'].includes(name) ? context.overlayCommit : null, build,
    artifacts: { worker: { digest: digest('3'), path: 'workers/' + name + '.mjs' } },
    ...(context.services[name].kind === 'container' ? { image: 'registry.cloudflare.com/' + 'c'.repeat(32) + '/mikka-' + name + '@' + digest('4'), imageDigest: digest('4'), localImageId: digest('5') } : {}) }]))
}

test('an unrelated commit and repeat runs retain every context, while a LiteLLM edit changes only LiteLLM', async t => {
  const { directory, put, git } = await fixture(t)
  const before = await buildContexts({ directory })
  await put('notes.md', 'An unrelated change\n'); git(['add', '.'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'unrelated source'])
  const after = await buildContexts({ directory })
  assert.notEqual(after.sourceCommit, before.sourceCommit)
  for (const name of serviceNames) assert.equal(after.services[name].contextDigest, before.services[name].contextDigest, name)
  await put('litellm/index.mjs', "export { value } from '../shared/value.mjs'\nexport const proxyVersion = 2\n")
  const changed = await buildContexts({ directory })
  assert.deepEqual(serviceNames.filter(name => changed.services[name].contextDigest !== before.services[name].contextDigest), ['litellm'])
  assert.equal(changed.migrations.contextDigest, before.migrations.contextDigest)
})

test('overlay and public build settings affect only the declared consumers', async t => {
  const { directory } = await fixture(t)
  const before = await buildContexts({ directory, overlayCommit: firstSource, publicSettings: { NAME: 'old' } })
  const after = await buildContexts({ directory, overlayCommit: secondSource, publicSettings: { NAME: 'new' } })
  assert.deepEqual(serviceNames.filter(name => before.services[name].contextDigest !== after.services[name].contextDigest), ['web'])
})

test('the production input declarations isolate a proxy configuration edit and do not rebuild it for API-only code', async t => {
  const { directory, put, git } = await fixture(t)
  const inputs = await readBuildInputs()
  await put('config/service-build-inputs.json', JSON.stringify(inputs))
  await put('package.json', '{"private":true}\n')
  await put('deploy/litellm/config.yaml', 'model_list: []\n')
  await put('apps/api/runtime/http-policy.mjs', 'export const limit = 1\n')
  git(['add', '.'])
  const first = await buildContexts({ directory, inputs })
  await put('deploy/litellm/config.yaml', 'model_list: []\n# reviewed proxy setting\n')
  const proxy = await buildContexts({ directory, inputs })
  assert.deepEqual(serviceNames.filter(name => proxy.services[name].contextDigest !== first.services[name].contextDigest), ['litellm'])
  await put('apps/api/runtime/http-policy.mjs', 'export const limit = 2\n')
  const api = await buildContexts({ directory, inputs })
  assert.notEqual(api.services.api.contextDigest, proxy.services.api.contextDigest)
  assert.equal(api.services.litellm.contextDigest, proxy.services.litellm.contextDigest)
})

test('migrations have an independent context so a migration-only change does not rebuild services', async t => {
  const { directory, put } = await fixture(t)
  const before = await buildContexts({ directory })
  await put('drizzle/202611200001_add_column.sql', 'ALTER TABLE example ADD COLUMN label varchar(100);\n')
  const after = await buildContexts({ directory })
  assert.notEqual(before.migrations.contextDigest, after.migrations.contextDigest)
  for (const name of serviceNames) assert.equal(before.services[name].contextDigest, after.services[name].contextDigest, name)
})

test('helper-only changes bind static and literal dynamic migration code without evaluating it or rebuilding services', async t => {
  const { directory, put } = await fixture(t)
  let before = await buildContexts({ directory, overlayCommit: firstSource })
  for (const file of ['scripts/migration-nested.mjs', 'scripts/migration-backfill.mjs', 'scripts/check-migrations.mjs']) {
    assert.ok(before.migrations.execution.files.includes(file), file)
    await put(file, 'export const changed = 2\n')
    const after = await buildContexts({ directory, overlayCommit: firstSource })
    assert.notEqual(after.migrations.execution.contextDigest, before.migrations.execution.contextDigest, file)
    assert.notEqual(after.migrations.contextDigest, before.migrations.contextDigest, file)
    assert.deepEqual(after.migrations.files, before.migrations.files)
    for (const name of serviceNames) assert.equal(after.services[name].contextDigest, before.services[name].contextDigest, name)
    const release = planServiceRelease(releaseManifest(before, publications(before)), releaseManifest(after, publications(after)))
    assert.equal(release.migrations.changed, true)
    assert.deepEqual(release.changedServices, [])
    before = after
  }
})

test('migration identity includes dependency declarations, patches, package-manager configuration and executable modes', async t => {
  const { directory, put, git } = await fixture(t)
  await put('patches/pg.patch', 'reviewed patch\n')
  await put('.npmrc', 'ignore-scripts=true\n')
  await put('packages/runtime/package.json', '{"private":true}\n')
  await put('.pnpmfile.mjs', "import './scripts/migration-hook.mjs'\n")
  await put('scripts/migration-hook.mjs', 'export const hook = 1\n')
  git(['add', '.'])
  let before = await buildContexts({ directory, overlayCommit: firstSource })
  for (const file of [...migrationToolchain, 'patches/pg.patch', '.npmrc', 'packages/runtime/package.json', '.pnpmfile.mjs', 'scripts/migration-hook.mjs']) {
    assert.ok(before.migrations.execution.files.includes(file), file)
    const original = await readFile(join(directory, file), 'utf8')
    await put(file, file === '.node-version' ? '26\n' : file.endsWith('.json')
      ? JSON.stringify({ ...JSON.parse(original), version: '2.0.0' }) + '\n'
      : original + (file.endsWith('.mjs') ? '// changed execution input\n' : '# changed toolchain input\n'))
    const after = await buildContexts({ directory, overlayCommit: firstSource })
    assert.notEqual(after.migrations.execution.contextDigest, before.migrations.execution.contextDigest, file)
    assert.notEqual(after.migrations.contextDigest, before.migrations.contextDigest, file)
    assert.equal(planServiceRelease(releaseManifest(before, publications(before)), releaseManifest(after, publications(after))).migrations.changed, true)
    before = after
  }
  await chmod(join(directory, 'scripts/migration-nested.mjs'), 0o755)
  const executable = await buildContexts({ directory, overlayCommit: firstSource })
  assert.notEqual(executable.migrations.execution.contextDigest, before.migrations.execution.contextDigest)
  assert.notEqual(executable.migrations.contextDigest, before.migrations.contextDigest)
})

test('computed migration imports, missing files, undeclared external modules and import escapes fail closed', async t => {
  const { directory, put } = await fixture(t)
  for (const source of [
    "await import(target)", "await import('./migration-' + 'backfill.mjs')", "await import(`./migration-backfill.mjs`)",
    "await import /* guarded comment */ (target)", "await import('./migration-backfill.mjs', {})",
    "await import('./migration-\\u0062ackfill.mjs')", "await import('./missing.mjs')", "await import('../outside.mjs?extra')",
    "await import('../../outside.mjs')", "await import('file:///tmp/private.mjs')", "await import('unknown-dependency')",
    "require('./migration-backfill.mjs')", "await import.meta.resolve('./migration-backfill.mjs')",
    "import {createRequire} from 'node:module'", "eval('load code')", "new Function('load code')",
    "import value from './migration-helper.mjs' with {type:'json'}", "import source value from './migration-helper.mjs'",
  ]) {
    await put('scripts/migrate.mjs', source + '\n')
    await assert.rejects(buildContexts({ directory }), undefined, source)
  }
  await put('scripts/untracked.mjs', 'export const value = 1\n')
  await put('scripts/migrate.mjs', "await import('./untracked.mjs')\n")
  await assert.rejects(buildContexts({ directory }), /Untracked or escaping/)
})

test('migration imports in template expressions and after comments cannot escape the execution identity', async t => {
  const { directory, put } = await fixture(t)
  await put('scripts/migrate.mjs', "export const value = `${await import /* comment */ ( /* argument */ './migration-backfill.mjs' /* end */ )}`\n")
  const before = await buildContexts({ directory })
  assert.ok(before.migrations.execution.files.includes('scripts/migration-backfill.mjs'))
  await put('scripts/migration-backfill.mjs', 'export const backfill = 2\n')
  assert.notEqual((await buildContexts({ directory })).migrations.contextDigest, before.migrations.contextDigest)
  await put('scripts/migrate.mjs', 'export const value = `${await import(target)}`\n')
  await assert.rejects(buildContexts({ directory }), /one literal path/)
})

test('every JavaScript line terminator preserves imports after a line comment', async t => {
  const { directory, put } = await fixture(t)
  for (const ending of ['\n', '\r', '\u2028', '\u2029']) {
    await put('scripts/migrate.mjs', `await import // comment${ending}('./migration-backfill.mjs');\n`)
    const context = await buildContexts({ directory })
    assert.ok(context.migrations.execution.files.includes('scripts/migration-backfill.mjs'), JSON.stringify(ending))
  }
})

test('multiline static imports and re-exports retain the same closure on supported Node parsers', async t => {
  const { directory, put } = await fixture(t)
  await put('scripts/migrate.mjs', "import\n { value }\n from './migration-helper.mjs'\nexport { backfill } from './migration-backfill.mjs'\n")
  const context = await buildContexts({ directory })
  for (const file of ['scripts/migration-helper.mjs', 'scripts/migration-nested.mjs', 'scripts/migration-backfill.mjs']) {
    assert.ok(context.migrations.execution.files.includes(file), file)
  }
})

test('migration execution inputs reject file and parent symlinks and an incomplete SQL source snapshot', async t => {
  const { directory, put, git, inputs } = await fixture(t)
  await rm(join(directory, 'scripts/migration-nested.mjs'))
  await symlink('migration-backfill.mjs', join(directory, 'scripts/migration-nested.mjs'))
  await assert.rejects(buildContexts({ directory }), /regular files/)
  await rm(join(directory, 'scripts/migration-nested.mjs'))
  await put('scripts/migration-nested.mjs', 'export const value = 1\n')
  await put('scripts/nested/helper.mjs', 'export const nested = 1\n')
  await put('scripts/migrate.mjs', "import './nested/helper.mjs'\n")
  git(['add', '.'])
  await rename(join(directory, 'scripts/nested'), join(directory, 'scripts/actual'))
  await symlink('actual', join(directory, 'scripts/nested'))
  await assert.rejects(buildContexts({ directory }), /parent must not be a symbolic link/)
  await rm(join(directory, 'scripts/nested'))
  await rename(join(directory, 'scripts/actual'), join(directory, 'scripts/nested'))
  inputs.migrations = ['drizzle/absent.sql']
  await assert.rejects(buildContexts({ directory, inputs }), /complete source snapshot/)
})

test('the checked-in migration execution identity contains the actual runner, checker, helper closure and declared toolchain', async () => {
  const context = await buildContexts()
  for (const file of [...migrationRoots, ...migrationToolchain,
    'scripts/bot-environment-backfill.mjs', 'scripts/task-workspace-evidence.mjs', 'scripts/preview-database-url.mjs',
    'scripts/integration-migration-history.mjs', 'patches/@workflow__world-postgres@5.4.1.patch']) {
    assert.ok(context.migrations.execution.files.includes(file), file)
  }
  assert.equal(context.migrations.version, 2)
  assert.deepEqual(context.migrations.execution.files, [...new Set(context.migrations.execution.files)].sort())
})

test('removing an imported path from the declared inputs fails coverage at that import', async t => {
  const { directory, inputs } = await fixture(t)
  assert.deepEqual(await assertInputCoverage({ directory, inputs }), { services: 6 })
  inputs.services.eve.groups = []
  await assert.rejects(assertInputCoverage({ directory, inputs }), error => {
    assert.match(error.message, /"service":"eve","importer":"eve\/index.mjs","imported":"shared\/value.mjs"/)
    return true
  })
})

test('the checked-in service entries cover their current transitive repository imports', async () => {
  assert.deepEqual(await assertInputCoverage(), { services: 6 })
  const inputs = await readBuildInputs()
  inputs.groups.toolchain = inputs.groups.toolchain.filter(path => path !== 'lib/deployment-id.mjs')
  inputs.services.world.paths = inputs.services.world.paths.filter(path => path !== 'lib/deployment-id.mjs')
  await assert.rejects(assertInputCoverage({ inputs }), /"service":"world"[^\n]+"imported":"lib\/deployment-id.mjs"/)
})

test('a repeated release reuses all original immutable artifacts and source receipts', () => {
  const initial = plan(), first = releaseManifest(initial, publications(initial))
  const next = releaseManifest({ ...initial, sourceCommit: secondSource }, {}, first)
  assert.equal(next.sourceCommit, secondSource)
  for (const name of serviceNames) {
    assert.equal(next.services[name].reused, true)
    assert.equal(next.services[name].sourceCommit, firstSource)
    assert.deepEqual(next.services[name].build, build)
    assert.equal(next.services[name].overlayCommit, ['api', 'web'].includes(name) ? firstSource : null)
    assert.equal(next.services[name].digest, first.services[name].digest)
  }
})

test('a single service change requires one new artifact; missing publication fails closed', () => {
  const initial = plan(), first = releaseManifest(initial, publications(initial))
  const next = { ...plan({ litellm: digest('8') }), sourceCommit: secondSource }
  assert.throws(() => releaseManifest(next, {}, first), /No published artifact for changed service: litellm/)
  const published = publications(next)
  published.litellm.imageDigest = digest('9')
  published.litellm.image = 'registry.cloudflare.com/' + 'c'.repeat(32) + '/mikka-litellm@' + digest('9')
  const release = releaseManifest(next, { litellm: published.litellm }, first)
  assert.deepEqual(serviceNames.filter(name => !release.services[name].reused), ['litellm'])
  assert.notEqual(release.services.litellm.digest, first.services.litellm.digest)
  for (const name of serviceNames.filter(name => name !== 'litellm')) assert.equal(release.services[name].digest, first.services[name].digest)
})

test('worker bytes participate in deployment identity even when a container image is unchanged', () => {
  const before = { imageDigest: digest('1'), artifacts: { worker: { digest: digest('2'), path: 'worker.mjs' } } }
  const after = { ...before, artifacts: { worker: { digest: digest('3'), path: 'worker.mjs' } } }
  assert.notEqual(serviceDigest(before), serviceDigest(after))
  assert.equal(serviceDigest(before), serviceDigest({ ...before, sourceCommit: secondSource, reused: true, build: { ...build, runId: '999' } }))
})

test('a manifest rejects mutable image references, traversal, and forged artifact digests', () => {
  const initial = plan(), release = releaseManifest(initial, publications(initial))
  for (const mutate of [
    value => { value.services.litellm.image = 'registry.cloudflare.com/' + 'c'.repeat(32) + '/mikka-litellm:latest' },
    value => { value.services.api.artifacts.worker.path = '../private/token' },
    value => { value.services.eve.digest = digest('f') },
    value => { value.services.task.build.artifactId = '' },
    value => { value.services.web.overlayCommit = null },
  ]) {
    const altered = structuredClone(release); mutate(altered)
    assert.throws(() => validateReleaseManifest(altered))
  }
})

test('new releases require complete v2 migration identity while historical receipts remain unchanged', () => {
  const initial = plan(), release = releaseManifest(initial, publications(initial))
  const old = structuredClone(release)
  delete old.migrations.version
  delete old.migrations.execution
  const original = structuredClone(old)
  assert.equal(validateHistoricalReleaseManifest(old), old)
  assert.throws(() => validateReleaseManifest(old), /execution identity v2/)
  assert.throws(() => releaseManifest({ ...initial, migrations: old.migrations }, publications(initial)), /execution identity v2/)
  const next = releaseManifest({ ...initial, sourceCommit: secondSource }, {}, old)
  assert.equal(next.migrations.version, 2)
  assert.deepEqual(old, original)
  for (const mutate of [
    value => { delete value.migrations.execution },
    value => { value.migrations.version = 1 },
    value => { value.migrations.unknown = true },
    value => { value.migrations.execution.entrypoint = 'scripts/other.mjs' },
    value => { value.migrations.execution.files = [] },
    value => { value.migrations.execution.files.push('scripts/migrate.mjs') },
    value => { value.migrations.execution.files.reverse() },
    value => { value.migrations.execution.files = value.migrations.execution.files.filter(file => file !== '.node-version') },
    value => { value.migrations.execution.files.push('../private/token') },
    value => { value.migrations.files.push(value.migrations.files[0]) },
  ]) {
    const altered = structuredClone(release); mutate(altered)
    assert.throws(() => validateReleaseManifest(altered))
  }
})
