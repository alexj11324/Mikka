import assert from 'node:assert/strict'
import { test } from 'node:test'
import { releasePlan, releaseVersion, verifyRelease } from '../scripts/release.mjs'

const sha = 'a'.repeat(40)
const options = { packageName: '@aspectlylabs/mikka', version: '0.0.4', sha }
const registry = records => async url => {
  const key = url.split('/').at(-1)
  const value = records[key]
  return { status: value === undefined ? 404 : 200, ok: value !== undefined, json: async () => value }
}

test('run versions are unique, retry-stable and newer than the initial 0.0.1', () => {
  assert.equal(releaseVersion('1'), '0.0.2')
  assert.equal(releaseVersion('3'), '0.0.4')
  assert.equal(releaseVersion('3'), releaseVersion('3'))
  for (const input of [undefined, '0', '-1', '1.1', '01', 'NaN', '9007199254740991']) assert.throws(() => releaseVersion(input))
})

test('new releases advance latest; older releases preserve it', async () => {
  assert.deepEqual(await releasePlan({ ...options, fetchRegistry: registry({ latest: { version: '0.0.3' } }) }), { published: false, tag: 'latest' })
  assert.deepEqual(await releasePlan({ ...options, fetchRegistry: registry({ latest: { version: '0.0.9' } }) }), { published: false, tag: 'build-0.0.4' })
  assert.deepEqual(await releasePlan({ ...options, fetchRegistry: registry({}) }), { published: false, tag: 'latest' })
})

test('retry skips a published version only when its commit matches', async () => {
  assert.deepEqual(await releasePlan({ ...options, fetchRegistry: registry({ '0.0.4': { gitHead: sha } }) }), { published: true, tag: '' })
  await assert.rejects(releasePlan({ ...options, fetchRegistry: registry({ '0.0.4': { gitHead: 'b'.repeat(40) } }) }), /does not match/)
  await assert.rejects(releasePlan({ ...options, fetchRegistry: registry({ '0.0.4': {} }) }), /does not match/)
})

test('registry errors and an unexpected version scheme stop release', async () => {
  await assert.rejects(releasePlan({ ...options, fetchRegistry: async () => ({ status: 503, ok: false }) }), /503/)
  await assert.rejects(releasePlan({ ...options, fetchRegistry: async () => { throw new Error('offline') } }), /offline/)
  await assert.rejects(releasePlan({ ...options, fetchRegistry: registry({ latest: { version: '1.0.0' } }) }), /version scheme/)
  await assert.rejects(releasePlan({ ...options, sha: 'main', fetchRegistry: registry({}) }), /Invalid release commit/)
})

test('CI stamps the runtime manifest and exports the same version and tag', async () => {
  const { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const temporary = await mkdtemp(join(tmpdir(), 'mikka-release-test-'))
  try {
    await mkdir(join(temporary, 'scripts'))
    await copyFile(new URL('../scripts/release.mjs', import.meta.url), join(temporary, 'scripts/release.mjs'))
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ name: '@mikka/daemon', version: '0.0.1', private: true }))
    await writeFile(join(temporary, 'registry.mjs'), 'globalThis.fetch = async () => ({ status: 404 })')
    execFileSync(process.execPath, ['--import', join(temporary, 'registry.mjs'), join(temporary, 'scripts/release.mjs')], {
      env: { ...process.env, GITHUB_RUN_NUMBER: '3', GITHUB_SHA: sha, GITHUB_OUTPUT: join(temporary, 'outputs'), MIKKA_DAEMON_PACKAGE_NAME: '@aspectlylabs/mikka' },
    })
    assert.deepEqual(JSON.parse(await readFile(join(temporary, 'package.json'), 'utf8')), { name: '@mikka/daemon', version: '0.0.4', private: true, gitHead: sha })
    assert.equal(await readFile(join(temporary, 'outputs'), 'utf8'), 'version=0.0.4\npublished=false\ntag=latest\n')
    const command = ['--import', join(temporary, 'registry.mjs'), join(temporary, 'scripts/release.mjs'), '--verify']
    const env = { ...process.env, GITHUB_RUN_NUMBER: '3', GITHUB_SHA: sha, GITHUB_OUTPUT: join(temporary, 'outputs'), MIKKA_DAEMON_PACKAGE_NAME: '@aspectlylabs/mikka' }
    await writeFile(join(temporary, 'registry.mjs'), 'globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ gitHead: process.env.GITHUB_SHA }) })')
    execFileSync(process.execPath, command, { env })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})


test('postpublish verification waits for delayed registry visibility', async () => {
  let checks = 0
  const waits = []
  const fetchRegistry = async url => {
    if (url.endsWith('/latest')) return { status: 404 }
    checks++
    return checks < 4 ? { status: 404 } : { status: 200, ok: true, json: async () => ({ gitHead: sha }) }
  }
  assert.deepEqual(await verifyRelease({ ...options, fetchRegistry }, async ms => waits.push(ms)), { published: true, tag: '' })
  assert.equal(checks, 4)
  assert.deepEqual(waits, [10_000, 10_000, 10_000])
})

test('postpublish visibility wait is bounded; mismatches fail immediately', async () => {
  const waits = []
  await assert.rejects(verifyRelease({ ...options, fetchRegistry: registry({}) }, async ms => waits.push(ms)), /accepted publication.*verification is incomplete/)
  assert.equal(waits.length, 30)
  assert.equal(waits.reduce((total, ms) => total + ms, 0), 300_000)
  await assert.rejects(verifyRelease({ ...options, fetchRegistry: registry({ '0.0.4': { gitHead: 'b'.repeat(40) } }) }, async () => assert.fail('must not wait for mismatched commit')), /does not match/)
})
