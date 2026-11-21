import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildEnvironment, checkedMarketingRepository, marketingGitHubOwner, resolveMarketingRepository, runMarketingCi, sourceContext } from './cloudflare-marketing-ci.mjs'

const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REPOSITORY_ID: '1427517699',
  GITHUB_ACTOR_ID: '183887963', GITHUB_ACTOR: 'alexj11324', GITHUB_TRIGGERING_ACTOR: 'alexj11324',
  GITHUB_REPOSITORY_OWNER_ID: '183887963', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/marketing-build.yml@refs/heads/main',
  GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1', MIKKA_MARKETING_SOURCE_SHA: 'b'.repeat(40) }
const transferredEnv = { ...env, GITHUB_REPOSITORY: 'aspectly-labs/Mikka', GITHUB_REPOSITORY_OWNER_ID: '359279274',
  GITHUB_WORKFLOW_REF: 'aspectly-labs/Mikka/.github/workflows/marketing-build.yml@refs/heads/main' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function repository(path, remote) {
  await mkdir(path, { recursive: true })
  git(path, 'init', '--quiet')
  git(path, 'remote', 'add', 'origin', 'https://github.com/' + remote + '.git')
  await writeFile(join(path, 'source'), 'unit source\n')
  git(path, 'add', 'source')
  git(path, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--quiet', '-m', 'Unit source')
  return git(path, 'rev-parse', 'HEAD')
}

test('the App installation owner defaults to Alex and admits only the approved transfer destination', () => {
  assert.equal(marketingGitHubOwner(), 'alexj11324')
  for (const owner of ['alexj11324', 'aspectly-labs']) assert.equal(marketingGitHubOwner(owner), owner)
  for (const owner of ['', 'someone', 'aspectly-labs/mikka-web', ' aspectly-labs', '__proto__']) {
    assert.throws(() => marketingGitHubOwner(owner), /MARKETING_PUBLIC_CI_INSTALLATION_OWNER_REQUIRED/)
  }
})

test('the private website source resolves by immutable identity before and after its approved transfer', async () => {
  const old = { id: 1429004608, full_name: 'alexj11324/mikka-web', private: true, fork: false,
    owner: { id: 183887963, login: 'alexj11324' } }
  const moved = { ...old, full_name: 'aspectly-labs/mikka-web', owner: { id: 359279274, login: 'aspectly-labs' } }
  for (const metadata of [old, moved]) {
    assert.equal(checkedMarketingRepository(metadata), metadata.full_name)
    assert.equal(await resolveMarketingRepository('fixture-read-token', async (url, options) => {
      assert.equal(url, 'https://api.github.com/repositories/1429004608')
      assert.equal(options.headers.authorization, 'Bearer fixture-read-token')
      assert.equal(options.redirect, 'error')
      return Response.json(metadata)
    }), metadata.full_name)
    assert.equal(sourceContext(env, env.GITHUB_SHA, metadata.full_name).privateRepository, metadata.full_name)
  }
  for (const patch of [{ id: 42 }, { private: false }, { fork: true }, { full_name: 'someone/mikka-web' },
    { owner: moved.owner }, { owner: { ...old.owner, login: 'aspectly-labs' } }, { full_name: '__proto__', owner: {} }]) {
    assert.throws(() => checkedMarketingRepository({ ...old, ...patch }), /MARKETING_PUBLIC_CI_PRIVATE_REPOSITORY/)
  }
  assert.throws(() => sourceContext(env, env.GITHUB_SHA, 'someone/mikka-web'), /PRIVATE_REPOSITORY/)
})

test('marketing requires public supplier identity and an exact website pin without passing credentials to compilation', () => {
  for (const selected of [env, transferredEnv]) {
    const context = sourceContext(selected, selected.GITHUB_SHA)
    assert.equal(context.repository, selected.GITHUB_REPOSITORY)
    assert.equal(context.workflowRef, selected.GITHUB_WORKFLOW_REF)
    assert.equal(context.privateRepository, 'alexj11324/mikka-web')
    const other = selected === env ? transferredEnv : env
    for (const [patch, code] of [
      [{ GITHUB_ACTIONS: undefined }, 'PROVIDER_REQUIRED'], [{ GITHUB_REPOSITORY_ID: '1429004608' }, 'REPOSITORY_REQUIRED'],
      [{ GITHUB_REPOSITORY_ID: undefined }, 'REPOSITORY_REQUIRED'], [{ GITHUB_REPOSITORY: 'someone/Mikka' }, 'REPOSITORY_REQUIRED'],
      [{ GITHUB_REPOSITORY: 'aspectly-labs/mikka-cloud' }, 'REPOSITORY_REQUIRED'],
      [{ GITHUB_REPOSITORY_OWNER_ID: undefined }, 'REPOSITORY_REQUIRED'], [{ GITHUB_REPOSITORY_OWNER_ID: '42' }, 'REPOSITORY_REQUIRED'],
      [{ GITHUB_REPOSITORY_OWNER_ID: other.GITHUB_REPOSITORY_OWNER_ID }, 'REPOSITORY_REQUIRED'],
      [{ GITHUB_REPOSITORY: other.GITHUB_REPOSITORY }, 'REPOSITORY_REQUIRED'],
      [{ GITHUB_SHA: 'c'.repeat(40) }, 'SOURCE_MISMATCH'], [{ GITHUB_REF: 'refs/heads/other' }, 'MAIN_REQUIRED'],
      [{ GITHUB_ACTOR_ID: '42' }, 'ACTOR_REQUIRED'], [{ GITHUB_ACTOR: 'other' }, 'ACTOR_REQUIRED'],
      [{ GITHUB_TRIGGERING_ACTOR: 'other' }, 'ACTOR_REQUIRED'],
      [{ GITHUB_EVENT_NAME: 'pull_request' }, 'EVENT_REQUIRED'], [{ GITHUB_EVENT_NAME: 'push' }, 'EVENT_REQUIRED'],
      [{ GITHUB_WORKFLOW_REF: 'other' }, 'WORKFLOW_REQUIRED'], [{ GITHUB_WORKFLOW_REF: other.GITHUB_WORKFLOW_REF }, 'WORKFLOW_REQUIRED'],
      [{ MIKKA_MARKETING_SOURCE_SHA: 'main' }, 'PRIVATE_PIN_REQUIRED'],
      [{ GITHUB_RUN_ID: '0' }, 'RUN_REQUIRED'], [{ GITHUB_RUN_ATTEMPT: '0' }, 'ATTEMPT_REQUIRED'],
    ]) assert.throws(() => sourceContext({ ...selected, ...patch }, selected.GITHUB_SHA), new RegExp(code))
  }
  const child = buildEnvironment({ PATH: '/bin', HOME: '/home/ci', MIKKA_MARKETING_READ_TOKEN: 'fixture-only',
    GH_TOKEN: 'fixture-only', GITHUB_APP_ID: 'fixture-only', GITHUB_APP_PRIVATE_KEY: 'fixture-only',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-only', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid',
    CLOUDFLARE_API_TOKEN: 'fixture-only', INFISICAL_CLIENT_SECRET: 'fixture-only', GITHUB_SHA: 'wrong-source',
    WORKERS_CI_COMMIT_SHA: 'wrong-owner', NODE_OPTIONS: '--inspect' })
  assert.equal(child.PATH, '/bin')
  assert.equal(child.HOME, '/home/ci')
  for (const key of ['MIKKA_MARKETING_READ_TOKEN', 'GH_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'CLOUDFLARE_API_TOKEN', 'INFISICAL_CLIENT_SECRET',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL',
    'GITHUB_SHA', 'WORKERS_CI_COMMIT_SHA', 'NODE_OPTIONS']) assert.equal(child[key], undefined)
})

for (const publicEnv of [env, transferredEnv]) test(`verification binds the public checkout, private checkout, public workflow run and exact private archive bytes under ${publicEnv.GITHUB_REPOSITORY}`, async t => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const directory = await mkdtemp(join(tmpdir(), 'mikka-marketing-owner-'))
  const publicRoot = join(directory, 'public')
  try {
    const publicSource = await repository(publicRoot, publicEnv.GITHUB_REPOSITORY)
    const privateRoot = join(publicRoot, '.mikka-web')
    const privateSource = await repository(privateRoot, 'alexj11324/mikka-web')
    const output = join(publicRoot, '.cloudflare-marketing')
    await mkdir(output)
    const bytes = Buffer.from('unit packaged website')
    await writeFile(join(output, 'marketing-worker.tgz'), bytes)
    const receipt = { version: 1, context: { provider: 'github-actions', repository: publicEnv.GITHUB_REPOSITORY, publicSource,
      privateRepository: 'alexj11324/mikka-web', privateSource, ref: publicEnv.GITHUB_REF, workflowRef: publicEnv.GITHUB_WORKFLOW_REF,
      runId: publicEnv.GITHUB_RUN_ID, runAttempt: publicEnv.GITHUB_RUN_ATTEMPT },
      archive: { name: 'marketing-worker.tgz', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, retention: 'private-github-release' }, publication: 'none' }
    const originalReceipt = JSON.stringify(receipt)
    await writeFile(join(output, 'receipt.json'), originalReceipt)
    const selected = { ...publicEnv, GITHUB_SHA: publicSource, MIKKA_MARKETING_SOURCE_SHA: privateSource }
    assert.deepEqual(await runMarketingCi({ env: selected, verify: true, publicRoot }), receipt)
    assert.equal(await readFile(join(output, 'receipt.json'), 'utf8'), originalReceipt)
    const other = publicEnv === env ? transferredEnv : env
    git(publicRoot, 'remote', 'set-url', 'origin', 'https://github.com/' + other.GITHUB_REPOSITORY + '.git')
    await assert.rejects(runMarketingCi({ env: selected, verify: true, publicRoot }), /REPOSITORY_REQUIRED/)
    git(publicRoot, 'remote', 'set-url', 'origin', 'https://github.com/' + publicEnv.GITHUB_REPOSITORY + '.git')
    const movedReceipt = structuredClone(receipt)
    movedReceipt.context.privateRepository = 'aspectly-labs/mikka-web'
    await writeFile(join(output, 'receipt.json'), JSON.stringify(movedReceipt))
    await assert.rejects(runMarketingCi({ env: selected, verify: true, publicRoot }), /CHECKOUT_MISMATCH/)
    git(privateRoot, 'remote', 'set-url', 'origin', 'https://github.com/aspectly-labs/mikka-web.git')
    assert.deepEqual(await runMarketingCi({ env: selected, verify: true, publicRoot }), movedReceipt)
    await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt))
    git(privateRoot, 'remote', 'set-url', 'origin', 'https://github.com/alexj11324/mikka-web.git')
    await assert.rejects(runMarketingCi({ env: { ...selected, GITHUB_RUN_ID: '9876' }, verify: true, publicRoot }), /RECEIPT_SOURCE_MISMATCH/)
    await assert.rejects(runMarketingCi({ env: { ...selected, MIKKA_MARKETING_SOURCE_SHA: 'c'.repeat(40) }, verify: true, publicRoot }), /CHECKOUT_MISMATCH/)
    await writeFile(join(output, 'marketing-worker.tgz'), 'changed artifact')
    await assert.rejects(runMarketingCi({ env: selected, verify: true, publicRoot }), /ARCHIVE_MISMATCH/)
    git(publicRoot, 'remote', 'set-url', 'origin', 'https://github.com/alexj11324/mikka-web.git')
    await assert.rejects(runMarketingCi({ env: selected, verify: true, publicRoot }), /REPOSITORY_REQUIRED/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('private publication starts without App authority and receives only its scoped token', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-marketing-app-boundary-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const publicRoot = join(directory, 'public'), privateRoot = join(publicRoot, '.mikka-web')
  const publicSource = await repository(publicRoot, 'alexj11324/Mikka')
  await repository(privateRoot, 'alexj11324/mikka-web')
  const bytes = Buffer.from('unit packaged website'), digest = createHash('sha256').update(bytes).digest('hex')
  await mkdir(join(privateRoot, 'scripts'))
  await writeFile(join(privateRoot, 'scripts/marketing-release-asset.mjs'), `import { readFileSync } from 'node:fs'
  import { execFileSync } from 'node:child_process'
  export async function publish(_directory, env) {
    const initial = process.platform === 'linux' ? readFileSync('/proc/self/environ', 'utf8')
      : execFileSync('ps', ['eww', '-p', String(process.pid)], { encoding: 'utf8' })
    for (const name of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL']) {
      if (Object.hasOwn(process.env, name) || Object.hasOwn(env, name)) throw Error('MARKETING_PRIVATE_AUTHORITY_EXPOSED:' + name)
      if (initial.includes(name + '=')) throw Error('MARKETING_PRIVATE_INITIAL_AUTHORITY_EXPOSED:' + name)
    }
    if (env.GH_TOKEN !== 'fixture-exact-repository-token') throw Error('MARKETING_PRIVATE_SCOPED_TOKEN_MISSING')
    return { repository: 'alexj11324/mikka-web', sha256: '${digest}', bytes: ${bytes.length} }
  }`)
  git(privateRoot, 'add', 'scripts/marketing-release-asset.mjs')
  git(privateRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--quiet', '-m', 'Private environment fixture')
  const privateSource = git(privateRoot, 'rev-parse', 'HEAD')
  const selected = { ...env, GITHUB_SHA: publicSource, MIKKA_MARKETING_SOURCE_SHA: privateSource }
  const output = join(publicRoot, '.cloudflare-marketing')
  await mkdir(output)
  await writeFile(join(output, 'marketing-worker.tgz'), bytes)
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ version: 1, context: sourceContext(selected, publicSource),
    archive: { name: 'marketing-worker.tgz', sha256: digest, bytes: bytes.length, retention: 'private-github-release' }, publication: 'none' }))
  const script = `import { publishMarketingCi } from ${JSON.stringify(new URL('./cloudflare-marketing-ci.mjs', import.meta.url).href)};
    await publishMarketingCi({ publicRoot: process.argv[1], env: { ...process.env, GITHUB_APP_ID: 'fixture-explicit-app-id',
      GITHUB_APP_PRIVATE_KEY: 'fixture-explicit-app-key', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-explicit-oidc-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid' } });`
  const workflow = await readFile(new URL('../.github/workflows/marketing-build.yml', import.meta.url), 'utf8')
  const launch = workflow.match(/run: exec (env [^\n]+) node scripts\/cloudflare-marketing-ci\.mjs publish/)?.[1].split(' ')
  assert.ok(launch, 'Private publication must exec a credential-clean process')
  execFileSync(launch[0], [...launch.slice(1), process.execPath, '--input-type=module', '-e', script, publicRoot], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: directory, ...selected, GH_TOKEN: 'fixture-exact-repository-token',
      GITHUB_APP_ID: 'fixture-app-id', GITHUB_APP_PRIVATE_KEY: 'fixture-app-key',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-oidc-token', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid' } })
  assert.equal(JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8')).publication, 'private-github-release')
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

test('marketing mints separate exact-repository App tokens after public source validation and scrubs the App key before private code', async () => {
  const workflow = await readFile(new URL('../.github/workflows/marketing-build.yml', import.meta.url), 'utf8')
  const steps = workflow.split(/^      - /m).slice(1)
  const step = text => {
    const matches = steps.filter(value => value.includes(text))
    assert.equal(matches.length, 1, text)
    return matches[0]
  }
  assert.match(workflow, /environment: marketing-build/)
  assert.match(workflow, /permissions:\n      contents: read\n      id-token: write/)
  assert.match(workflow, /if: github\.repository_id == '1427517699'.*github\.ref == 'refs\/heads\/main'.*github\.actor_id == '183887963'.*github\.triggering_actor == 'alexj11324'/)
  assert.match(workflow, /MIKKA_MARKETING_GITHUB_OWNER: \$\{\{ vars\.MIKKA_MARKETING_GITHUB_OWNER \|\| 'alexj11324' }}/)
  const preflight = step('id: website-owner')
  assert.ok(preflight.includes("sourceContext(process.env, execFileSync('git', ['rev-parse', 'HEAD']"))
  assert.ok(preflight.includes('marketingGitHubOwner(process.env.MIKKA_MARKETING_GITHUB_OWNER)'))
  const deliveries = steps.filter(value => value.includes('uses: Infisical/secrets-action@'))
  assert.equal(deliveries.length, 2)
  for (const name of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY']) {
    const delivery = step('secret-name: ' + name + '\n')
    assert.match(delivery, /uses: Infisical\/secrets-action@d2e351f16c6ca20d17c85e6c992e04bdeb64e87d/)
    for (const field of ['method: oidc', 'identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac',
      'oidc-audience: mikka-infisical', 'project-id: 89850d6a-f020-4936-863e-df77380dfe40',
      'env-slug: prod', 'secret-path: ${{ steps.source-app.outputs.secret-path }}', 'recursive: false', 'include-imports: false']) assert.ok(delivery.includes(field))
    assert.ok(steps.indexOf(preflight) < steps.indexOf(delivery))
  }
  assert.ok(step('name: Verify the selected source App').includes('process.env.GITHUB_APP_ID !== process.env.EXPECTED_SOURCE_APP_ID'))
  const tokens = steps.filter(value => value.includes('uses: actions/create-github-app-token@'))
  assert.equal(tokens.length, 2)
  for (const [id, permission] of [['website-read-token', 'read'], ['website-release-token', 'write']]) {
    const token = step('id: ' + id + '\n')
    assert.match(token, /uses: actions\/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349/)
    for (const field of ['app-id: ${{ env.GITHUB_APP_ID }}', 'private-key: ${{ env.GITHUB_APP_PRIVATE_KEY }}',
      'owner: ${{ steps.website-owner.outputs.owner }}', 'repositories: mikka-web\n', 'permission-contents: ' + permission]) assert.ok(token.includes(field))
    assert.doesNotMatch(token, /skip-token-revoke: true|permission-[a-z-]+: (?:admin|none)/)
  }
  const scrub = step('name: Remove App credentials before loading private website code')
  assert.match(scrub, /if: always\(\)/)
  for (const name of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY']) assert.ok(scrub.includes("echo '" + name + "=' >> \"$GITHUB_ENV\""))
  const build = step('node scripts/cloudflare-marketing-ci.mjs build')
  const publish = step('node scripts/cloudflare-marketing-ci.mjs publish')
  for (const action of ['build', 'verify', 'publish']) {
    const source = step('node scripts/cloudflare-marketing-ci.mjs ' + action)
    assert.ok(source.includes('run: exec env -u GITHUB_APP_ID -u GITHUB_APP_PRIVATE_KEY -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL node'))
  }
  assert.ok(tokens.every(token => steps.indexOf(token) < steps.indexOf(scrub)))
  assert.ok(steps.indexOf(scrub) < steps.indexOf(build))
  assert.ok(build.includes('MIKKA_MARKETING_READ_TOKEN: ${{ steps.website-read-token.outputs.token }}'))
  assert.ok(publish.includes('GH_TOKEN: ${{ steps.website-release-token.outputs.token }}'))
  assert.doesNotMatch(workflow, /secrets\.MIKKA_MARKETING_(?:READ|RELEASE)_TOKEN/)
})
