import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildEnvironment, runMarketingCi, sourceContext } from './cloudflare-marketing-ci.mjs'

const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REPOSITORY_ID: '1427517699',
  GITHUB_ACTOR_ID: '183887963', GITHUB_ACTOR: 'alexj11324', GITHUB_TRIGGERING_ACTOR: 'alexj11324',
  GITHUB_REPOSITORY_OWNER_ID: '183887963', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/marketing-build.yml@refs/heads/main',
  GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1', MIKKA_MARKETING_SOURCE_SHA: 'b'.repeat(40) }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

test('marketing requires public supplier identity and an exact website pin without passing credentials to compilation', () => {
  assert.equal(sourceContext(env, env.GITHUB_SHA).privateRepository, 'alexj11324/mikka-web')
  for (const [patch, code] of [
    [{ GITHUB_ACTIONS: undefined }, 'PROVIDER_REQUIRED'], [{ GITHUB_REPOSITORY_ID: '1429004608' }, 'REPOSITORY_REQUIRED'],
    [{ GITHUB_SHA: 'c'.repeat(40) }, 'SOURCE_MISMATCH'], [{ GITHUB_REF: 'refs/heads/other' }, 'MAIN_REQUIRED'],
    [{ GITHUB_ACTOR_ID: '42' }, 'ACTOR_REQUIRED'], [{ GITHUB_TRIGGERING_ACTOR: 'other' }, 'ACTOR_REQUIRED'],
    [{ GITHUB_EVENT_NAME: 'pull_request' }, 'EVENT_REQUIRED'], [{ GITHUB_WORKFLOW_REF: 'other' }, 'WORKFLOW_REQUIRED'],
    [{ MIKKA_MARKETING_SOURCE_SHA: 'main' }, 'PRIVATE_PIN_REQUIRED'],
    [{ GITHUB_RUN_ID: '0' }, 'RUN_REQUIRED'], [{ GITHUB_RUN_ATTEMPT: '0' }, 'ATTEMPT_REQUIRED'],
  ]) assert.throws(() => sourceContext({ ...env, ...patch }, env.GITHUB_SHA), new RegExp(code))
  const child = buildEnvironment({ PATH: '/bin', HOME: '/home/ci', MIKKA_MARKETING_READ_TOKEN: 'fixture-only',
    CLOUDFLARE_API_TOKEN: 'fixture-only', INFISICAL_CLIENT_SECRET: 'fixture-only', GITHUB_SHA: 'wrong-source',
    WORKERS_CI_COMMIT_SHA: 'wrong-owner', NODE_OPTIONS: '--inspect' })
  assert.equal(child.PATH, '/bin')
  assert.equal(child.HOME, '/home/ci')
  for (const key of ['MIKKA_MARKETING_READ_TOKEN', 'CLOUDFLARE_API_TOKEN', 'INFISICAL_CLIENT_SECRET',
    'GITHUB_SHA', 'WORKERS_CI_COMMIT_SHA', 'NODE_OPTIONS']) assert.equal(child[key], undefined)
})

test('verification binds the public checkout, private checkout, public workflow run and exact private archive bytes', async t => {
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
    const receipt = { version: 1, context: { ...sourceContext(env, env.GITHUB_SHA), publicSource, privateSource },
      archive: { name: 'marketing-worker.tgz', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, retention: 'private-github-release' }, publication: 'none' }
    await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt))
    const selected = { ...env, GITHUB_SHA: publicSource, MIKKA_MARKETING_SOURCE_SHA: privateSource }
    assert.deepEqual(await runMarketingCi({ env: selected, verify: true, publicRoot }), receipt)
    await assert.rejects(runMarketingCi({ env: { ...selected, GITHUB_RUN_ID: '9876' }, verify: true, publicRoot }), /RECEIPT_SOURCE_MISMATCH/)
    await assert.rejects(runMarketingCi({ env: { ...selected, MIKKA_MARKETING_SOURCE_SHA: 'c'.repeat(40) }, verify: true, publicRoot }), /CHECKOUT_MISMATCH/)
    await writeFile(join(output, 'marketing-worker.tgz'), 'changed artifact')
    await assert.rejects(runMarketingCi({ env: selected, verify: true, publicRoot }), /ARCHIVE_MISMATCH/)
    git(publicRoot, 'remote', 'set-url', 'origin', 'https://github.com/alexj11324/mikka-web.git')
    await assert.rejects(runMarketingCi({ env: selected, verify: true, publicRoot }), /REPOSITORY_REQUIRED/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})


test('the public workflow retains only metadata and checksums while the private archive stays outside its artifact paths', async () => {
  const workflow = await readFile(new URL('../.github/workflows/marketing-build.yml', import.meta.url), 'utf8')
  const paths = workflow.match(/          path: \|\n((?:            .+\n)+)/)?.[1].trim().split(/\r?\n/).map(value => value.trim())
  assert.deepEqual(paths, ['.cloudflare-marketing/receipt.json', '.cloudflare-marketing/marketing-worker.sha256'])
  assert.ok(workflow.includes('include-hidden-files: true'))
  assert.ok(workflow.includes('runs-on: ubuntu-latest'))
  assert.ok(workflow.includes('environment: marketing-build'))
  assert.ok(!workflow.includes('self-hosted'))
})
