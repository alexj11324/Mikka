import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { assertInputCoverage, buildContexts, readBuildInputs, releaseManifest, serviceDigest, serviceNames, validateReleaseManifest } from './service-builds.mjs'

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
  git(['init', '--quiet']); git(['add', '.'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'initial inputs'])
  return { directory, put, git, inputs }
}

function plan(contexts = {}) {
  return { version: 1, sourceCommit: firstSource, overlayCommit: null,
    services: Object.fromEntries(serviceNames.map(name => [name, { kind: ['web', 'world'].includes(name) ? 'worker' : 'container', contextDigest: contexts[name] ?? digest('1') }])),
    migrations: { contextDigest: digest('2'), files: ['drizzle/202611200001_add_column.sql'] } }
}

function publications(context) {
  return Object.fromEntries(serviceNames.map(name => [name, { ...context.services[name], sourceCommit: context.sourceCommit, build,
    artifacts: { worker: { digest: digest('3'), path: 'workers/' + name + '.mjs' } },
    ...(context.services[name].kind === 'container' ? { image: 'registry.cloudflare.com/' + 'c'.repeat(32) + '/mikka-' + name + '@' + digest('4'), imageDigest: digest('4') } : {}) }]))
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

test('migrations have an independent context so a migration-only change does not rebuild services', async t => {
  const { directory, put } = await fixture(t)
  const before = await buildContexts({ directory })
  await put('drizzle/202611200001_add_column.sql', 'ALTER TABLE example ADD COLUMN label varchar(100);\n')
  const after = await buildContexts({ directory })
  assert.notEqual(before.migrations.contextDigest, after.migrations.contextDigest)
  for (const name of serviceNames) assert.equal(before.services[name].contextDigest, after.services[name].contextDigest, name)
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
  ]) {
    const altered = structuredClone(release); mutate(altered)
    assert.throws(() => validateReleaseManifest(altered))
  }
})

