import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { serviceDigest } from './service-builds.mjs'
import { planServiceRelease } from './service-diff.mjs'

const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex')
function release() {
  return { version: 1, sourceCommit: 'a'.repeat(40), overlayCommit: 'b'.repeat(40),
    services: Object.fromEntries(['web', 'api', 'eve', 'task', 'world', 'litellm'].map(name => {
      const worker = name === 'web' || name === 'world'
      const imageDigest = digest(name + ':image')
      const service = { kind: worker ? 'worker' : 'container', contextDigest: digest(name + ':context'),
        sourceCommit: 'a'.repeat(40), reused: false,
        build: { runId: '101', runAttempt: '1', artifactId: '201', workflow: 'cloudflare-api-image.yml' },
        artifacts: { worker: { path: name + '/worker.mjs', digest: digest(name + ':worker') } },
        ...(!worker ? { imageDigest, image: 'registry.cloudflare.com/' + 'c'.repeat(32) + '/mikka-' + name + '@' + imageDigest } : {}) }
      return [name, { ...service, digest: serviceDigest(service) }]
    })),
    migrations: { contextDigest: digest('initial migrations'), files: ['drizzle/20261120000000_initial.sql'] } }
}
function change(manifest, name) {
  const service = manifest.services[name]
  service.sourceCommit = manifest.sourceCommit
  service.contextDigest = digest(name + ':changed context')
  service.artifacts.worker.digest = digest(name + ':changed worker')
  service.digest = serviceDigest(service)
}

test('unchanged artifacts retain every service despite a new release commit', () => {
  const current = release(), next = structuredClone(current)
  next.sourceCommit = 'd'.repeat(40)
  for (const service of Object.values(next.services)) service.reused = true
  const plan = planServiceRelease(current, next)
  assert.deepEqual(plan.changedServices, [])
  assert.deepEqual(plan.retainedServices, ['world', 'task', 'litellm', 'eve', 'api', 'web'])
  assert.equal(plan.migrations.changed, false)
  assert.equal(plan.services.eve.after.sourceCommit, current.services.eve.sourceCommit)
})

test('a LiteLLM-only release changes one deployment unit and retains the other five', () => {
  const current = release(), next = structuredClone(current)
  next.sourceCommit = 'd'.repeat(40)
  change(next, 'litellm')
  const plan = planServiceRelease(current, next)
  assert.deepEqual(plan.changedServices, ['litellm'])
  assert.deepEqual(plan.deploymentOrder, ['litellm'])
  for (const name of ['web', 'api', 'eve', 'task', 'world']) {
    assert.equal(plan.services[name].changed, false)
    assert.deepEqual(plan.services[name].after, current.services[name])
  }
})

test('multiple changed services deploy before their callers', () => {
  const current = release(), next = structuredClone(current)
  for (const name of ['web', 'api', 'eve', 'world', 'task']) change(next, name)
  assert.deepEqual(planServiceRelease(current, next).deploymentOrder, ['world', 'task', 'eve', 'api', 'web'])
})

test('a Worker artifact change deploys even without a container image change', () => {
  const current = release(), next = structuredClone(current)
  change(next, 'world')
  assert.deepEqual(planServiceRelease(current, next).changedServices, ['world'])
})

test('a migration-only release has no service deployment and preserves the previous ledger', () => {
  const current = release(), next = structuredClone(current)
  next.migrations = { contextDigest: digest('expanded migrations'),
    files: [...current.migrations.files, 'drizzle/20261120010000_add_title.sql'] }
  const plan = planServiceRelease(current, next)
  assert.deepEqual(plan.deploymentOrder, [])
  assert.equal(plan.migrations.changed, true)
  assert.deepEqual(plan.migrations.before, current.migrations)
  assert.deepEqual(plan.migrations.after, next.migrations)
  next.migrations.files.shift()
  assert.throws(() => planServiceRelease(current, next), /cannot remove previously released migrations/)
})

test('incomplete manifests and forged deployment digests fail before producing a plan', () => {
  const current = release(), next = structuredClone(current)
  delete next.services.task
  assert.throws(() => planServiceRelease(current, next))
  const forged = release()
  forged.services.api.digest = digest('unrelated artifact')
  assert.throws(() => planServiceRelease(current, forged), /artifact digest differs/)
})

test('explicit first-release bootstrap keeps the previous state unknown instead of inventing a manifest', () => {
  const next = release()
  const plan = planServiceRelease(null, next)
  assert.equal(plan.bootstrap, true)
  assert.equal(plan.previousSourceCommit, null)
  assert.deepEqual(plan.changedServices, ['world', 'task', 'litellm', 'eve', 'api', 'web'])
  assert.deepEqual(plan.retainedServices, [])
  assert.equal(plan.migrations.before, null)
  assert.equal(plan.migrations.changed, true)
  assert.equal(Object.values(plan.services).every(service => service.before === null && service.changed), true)
  assert.throws(() => planServiceRelease(undefined, next))
  assert.equal(planServiceRelease(next, next).bootstrap, false)
})

test('the CLI writes the full plan and prints only the release summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-service-diff-'))
  try {
    const current = release(), next = structuredClone(current)
    change(next, 'litellm')
    const paths = ['current.json', 'next.json', 'plan.json'].map(file => join(directory, file))
    await writeFile(paths[0], JSON.stringify(current))
    await writeFile(paths[1], JSON.stringify(next))
    const stdout = execFileSync(process.execPath, [new URL('./service-diff.mjs', import.meta.url).pathname, ...paths], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(stdout).changedServices, ['litellm'])
    assert.equal(stdout.includes('registry.cloudflare.com'), false)
    assert.deepEqual(JSON.parse(await readFile(paths[2], 'utf8')).retainedServices, ['world', 'task', 'eve', 'api', 'web'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
