import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runCloudCi, sourceContext } from './cloudflare-cloud-ci.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const env = {
  WORKERS_CI: '1', WORKERS_CI_COMMIT_SHA: 'a'.repeat(40),
  WORKERS_CI_BRANCH: 'main', WORKERS_CI_BUILD_UUID: 'public-build-uuid',
  MIKKA_CLOUD_SOURCE_SHA: 'b'.repeat(40),
}

test('public provider identity requires actual public commit and a complete private pin', () => {
  assert.equal(sourceContext(env, env.WORKERS_CI_COMMIT_SHA).repository, 'alexj11324/Mikka')
  for (const [overrides, code] of [
    [{ WORKERS_CI: undefined }, 'PROVIDER_REQUIRED'],
    [{ WORKERS_CI_COMMIT_SHA: 'c'.repeat(40) }, 'SOURCE_MISMATCH'],
    [{ MIKKA_CLOUD_SOURCE_SHA: 'main' }, 'PRIVATE_PIN_REQUIRED'],
    [{ WORKERS_CI_BRANCH: '-main' }, 'BRANCH_INVALID'],
    [{ WORKERS_CI_BUILD_UUID: '' }, 'BUILD_ID_REQUIRED'],
  ]) assert.throws(() => sourceContext({ ...env, ...overrides }, env.WORKERS_CI_COMMIT_SHA), new RegExp(code))
})

async function repository(directory, origin, files) {
  await mkdir(directory, { recursive: true })
  git(directory, 'init')
  git(directory, 'remote', 'add', 'origin', `https://github.com/${origin}.git`)
  for (const [name, source] of Object.entries(files)) {
    await mkdir(join(directory, name, '..'), { recursive: true })
    await writeFile(join(directory, name), source)
  }
  git(directory, 'add', '.')
  git(directory, '-c', 'user.name=CI Fixture', '-c', 'user.email=ci@example.test', 'commit', '-m', 'fixture')
  return git(directory, 'rev-parse', 'HEAD')
}

test('public checkout invokes the pinned compiler and rejects provenance or checkout drift', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-public-cloud-ci-'))
  try {
    const publicRoot = join(directory, 'public')
    const publicSource = await repository(publicRoot, 'alexj11324/Mikka', { '.gitignore': '/.mikka-cloud/\n' })
    const privateRoot = join(publicRoot, '.mikka-cloud')
    const privateSource = await repository(privateRoot, 'alexj11324/mikka-cloud', {
      'scripts/cloudflare-ci.mjs': `export async function runCi({ env, verify, publicRoot, publicSource }) {
        if (!publicRoot || !publicSource) throw new Error('missing public owner')
        return { publication: 'none', verified: verify, context: {
          provider: 'cloudflare-workers-builds', repository: 'alexj11324/Mikka', publicSource,
          sha: env.MIKKA_CLOUD_SOURCE_SHA, branch: env.WORKERS_CI_BRANCH,
          buildId: env.WORKERS_CI_BRANCH === 'wrong-receipt' ? 'private-build' : env.WORKERS_CI_BUILD_UUID,
        } }
      }`,
    })
    const buildEnv = { ...env, WORKERS_CI_COMMIT_SHA: publicSource, MIKKA_CLOUD_SOURCE_SHA: privateSource }
    const result = await runCloudCi({ env: buildEnv, publicRoot, verify: true })
    assert.deepEqual(result.context, {
      provider: 'cloudflare-workers-builds', repository: 'alexj11324/Mikka', publicSource, privateSource,
      branch: 'main', buildId: 'public-build-uuid',
    })
    assert.equal(result.receipt.verified, true)
    await assert.rejects(runCloudCi({ env: { ...buildEnv, WORKERS_CI_BRANCH: 'wrong-receipt' }, publicRoot }), /RECEIPT_SOURCE_MISMATCH/)
    await assert.rejects(runCloudCi({ env: { ...buildEnv, MIKKA_CLOUD_SOURCE_SHA: 'c'.repeat(40) }, publicRoot }), /PRIVATE_SOURCE_MISMATCH/)
    await writeFile(join(privateRoot, 'scripts/cloudflare-ci.mjs'), 'throw new Error("dirty compiler executed")')
    await assert.rejects(runCloudCi({ env: buildEnv, publicRoot }), /PRIVATE_SOURCE_MISMATCH/)
    git(publicRoot, 'remote', 'set-url', 'origin', 'https://github.com/alexj11324/mikka-cloud.git')
    await assert.rejects(runCloudCi({ env: buildEnv, publicRoot }), /REPOSITORY_REQUIRED/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
