import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildEnvironment, runMarketingCi, sourceContext } from './cloudflare-marketing-ci.mjs'

const buildId = '5d31dcaa-1234-4000-aaaa-112233445566'
const env = { WORKERS_CI: '1', WORKERS_CI_COMMIT_SHA: 'a'.repeat(40), WORKERS_CI_BRANCH: 'main',
  WORKERS_CI_BUILD_UUID: buildId, MIKKA_MARKETING_SOURCE_SHA: 'b'.repeat(40) }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

test('marketing requires public supplier identity and an exact website pin without passing credentials to compilation', () => {
  assert.equal(sourceContext(env, env.WORKERS_CI_COMMIT_SHA).privateRepository, 'alexj11324/mikka-web')
  for (const [patch, code] of [
    [{ WORKERS_CI: undefined }, 'PROVIDER_REQUIRED'], [{ CF_PAGES: '1' }, 'PROVIDER_REQUIRED'],
    [{ WORKERS_CI_COMMIT_SHA: 'c'.repeat(40) }, 'SOURCE_MISMATCH'],
    [{ MIKKA_MARKETING_SOURCE_SHA: 'main' }, 'PRIVATE_PIN_REQUIRED'],
    [{ WORKERS_CI_BUILD_UUID: '123' }, 'BUILD_UUID_REQUIRED'], [{ WORKERS_CI_BRANCH: '-main' }, 'BRANCH_REQUIRED'],
  ]) assert.throws(() => sourceContext({ ...env, ...patch }, env.WORKERS_CI_COMMIT_SHA), new RegExp(code))
  const child = buildEnvironment({ PATH: '/bin', HOME: '/home/ci', MIKKA_MARKETING_READ_TOKEN: 'fixture-only',
    CLOUDFLARE_API_TOKEN: 'fixture-only', INFISICAL_CLIENT_SECRET: 'fixture-only', GITHUB_SHA: 'wrong-source',
    WORKERS_CI_COMMIT_SHA: 'wrong-owner', NODE_OPTIONS: '--inspect' })
  assert.equal(child.PATH, '/bin')
  assert.equal(child.HOME, '/home/ci')
  for (const key of ['MIKKA_MARKETING_READ_TOKEN', 'CLOUDFLARE_API_TOKEN', 'INFISICAL_CLIENT_SECRET',
    'GITHUB_SHA', 'WORKERS_CI_COMMIT_SHA', 'NODE_OPTIONS']) assert.equal(child[key], undefined)
})

test('verification binds the public checkout, private checkout, supplier UUID and exact ephemeral archive bytes', async t => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const directory = await mkdtemp(join(tmpdir(), 'mikka-marketing-owner-'))
  const publicRoot = join(directory, 'public')
  async function repository(path, remote) {
    await mkdir(path, { recursive: true })
    git(path, 'init', '--quiet')
    git(path, 'remote', 'add', 'origin', 'https://github.com/' + remote + '.git')
    await writeFile(join(path, 'source'), 'unit source\n')
    git(path, 'add', 'source')
    git(path, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--quiet', '-m', 'Unit source')
    return git(path, 'rev-parse', 'HEAD')
  }
  try {
    const publicSource = await repository(publicRoot, 'alexj11324/Mikka')
    const privateRoot = join(publicRoot, '.mikka-web')
    const privateSource = await repository(privateRoot, 'alexj11324/mikka-web')
    const output = join(publicRoot, '.cloudflare-marketing')
    await mkdir(output)
    const bytes = Buffer.from('unit packaged website')
    await writeFile(join(output, 'marketing-worker.tgz'), bytes)
    const receipt = { version: 1, context: { provider: 'cloudflare-workers-builds', repository: 'alexj11324/Mikka', publicSource,
      privateRepository: 'alexj11324/mikka-web', privateSource, branch: 'main', buildId },
      archive: { name: 'marketing-worker.tgz', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, retention: 'ephemeral' }, publication: 'none' }
    await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt))
    const selected = { ...env, WORKERS_CI_COMMIT_SHA: publicSource, MIKKA_MARKETING_SOURCE_SHA: privateSource }
    assert.deepEqual(await runMarketingCi({ env: selected, verify: true, publicRoot }), receipt)
    await assert.rejects(runMarketingCi({ env: { ...selected, WORKERS_CI_BUILD_UUID: '6d31dcaa-1234-4000-aaaa-112233445566' }, verify: true, publicRoot }), /RECEIPT_SOURCE_MISMATCH/)
    await assert.rejects(runMarketingCi({ env: { ...selected, MIKKA_MARKETING_SOURCE_SHA: 'c'.repeat(40) }, verify: true, publicRoot }), /CHECKOUT_MISMATCH/)
    await writeFile(join(output, 'marketing-worker.tgz'), 'changed artifact')
    await assert.rejects(runMarketingCi({ env: selected, verify: true, publicRoot }), /ARCHIVE_MISMATCH/)
    git(publicRoot, 'remote', 'set-url', 'origin', 'https://github.com/alexj11324/mikka-web.git')
    await assert.rejects(runMarketingCi({ env: selected, verify: true, publicRoot }), /REPOSITORY_REQUIRED/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
