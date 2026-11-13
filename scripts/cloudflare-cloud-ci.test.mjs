import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runCloudCi, sourceContext, verifyPublicReceipt, verifyPublishedArtifact } from './cloudflare-cloud-ci.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const env = {
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REPOSITORY_ID: '1427517699',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main',
  GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/cloud-services-ci.yml@refs/heads/main',
  GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '2', GITHUB_ACTOR_ID: '183887963',
  MIKKA_CLOUD_SOURCE_SHA: 'b'.repeat(40),
}
const stages = [
  'platform', 'github-source-download', 'submodule', 'install-private', 'install-public', 'browser-install',
  'browser-platform', 'ops-python', 'ops-contracts', 'typecheck-core', 'typecheck-models', 'typecheck-ui',
  'postgres17-core-models-and-eve', 'vercel-build', 'vercel-startup', 'browser-capture', 'node-build',
  'artifact-check', 'worker-dry-run', 'docker-build', 'image-postgres-runtime', 'current-public-postgres17',
].map(name => ({ name, exit: 0 }))
function qualifiedArtifact(context) {
  return { privateSource: context.privateSource, modelSource: 'e'.repeat(40), publicSource: context.publicSource,
    runId: context.runId, runAttempt: context.runAttempt, localImageId: 'sha256:' + 'f'.repeat(64),
    workerDigest: '1'.repeat(64), manifestSha256: '2'.repeat(64) }
}
function receipt(context) {
  const { privateSource, ...shared } = context
  return {
    version: 1, qualifiedArtifact: qualifiedArtifact(context), context: { ...shared, sha: privateSource }, publicMainCompatibilitySha: 'c'.repeat(40),
    stages, artifactSha256: 'd'.repeat(64), databaseIntegration: 'isolated-postgresql-17-core-models-and-eve',
    imageRuntimeExecutor: 'image-files-node24', publication: 'none',
  }
}

test('public Actions identity binds owner, repository, workflow, main, source and numeric run identity', () => {
  const context = sourceContext(env, env.GITHUB_SHA)
  assert.deepEqual(context, {
    provider: 'github-actions', repository: 'alexj11324/Mikka', publicSource: 'a'.repeat(40),
    privateSource: 'b'.repeat(40), branch: 'main', ref: 'refs/heads/main',
    workflowRef: 'alexj11324/Mikka/.github/workflows/cloud-services-ci.yml@refs/heads/main',
    workflowSha: 'a'.repeat(40), runId: '123456', runAttempt: '2', actorId: '183887963', buildId: '123456-2',
  })
  for (const [key, value, code] of [
    ['GITHUB_ACTIONS', undefined, 'PROVIDER_REQUIRED'], ['GITHUB_ACTIONS', '1', 'PROVIDER_REQUIRED'],
    ['GITHUB_REPOSITORY', 'fork/Mikka', 'REPOSITORY_REQUIRED'], ['GITHUB_REPOSITORY_ID', '1', 'REPOSITORY_REQUIRED'],
    ['GITHUB_SHA', 'c'.repeat(40), 'SOURCE_MISMATCH'], ['GITHUB_WORKFLOW_SHA', 'c'.repeat(40), 'SOURCE_MISMATCH'],
    ['MIKKA_CLOUD_SOURCE_SHA', 'main', 'PRIVATE_PIN_REQUIRED'],
    ['GITHUB_EVENT_NAME', 'pull_request_target', 'WORKFLOW_REQUIRED'], ['GITHUB_REF', 'refs/heads/other', 'WORKFLOW_REQUIRED'],
    ['GITHUB_REF_NAME', 'other', 'WORKFLOW_REQUIRED'], ['GITHUB_WORKFLOW_REF', 'other', 'WORKFLOW_REQUIRED'],
    ['GITHUB_ACTOR_ID', '1', 'ACTOR_REQUIRED'], ['GITHUB_RUN_ID', '0', 'BUILD_ID_REQUIRED'],
    ['GITHUB_RUN_ID', '123\n', 'BUILD_ID_REQUIRED'], ['GITHUB_RUN_ATTEMPT', 'attempt', 'BUILD_ID_REQUIRED'],
  ]) assert.throws(() => sourceContext({ ...env, [key]: value }, env.GITHUB_SHA), new RegExp(code))
  assert.throws(() => sourceContext({ WORKERS_CI: '1' }, env.GITHUB_SHA), /PROVIDER_REQUIRED/)
})

test('public receipts contain only complete source-bound qualification metadata', () => {
  const context = sourceContext(env, env.GITHUB_SHA)
  assert.deepEqual(verifyPublicReceipt(receipt(context), context), receipt(context))
  for (const key of Object.keys(receipt(context).context)) {
    const changed = receipt(context)
    changed.context[key] = 'drift'
    assert.throws(() => verifyPublicReceipt(changed, context), /RECEIPT_SOURCE_MISMATCH/)
  }
  for (const mutate of [
    value => { value.logs = 'private compiler output' },
    value => { value.context.logs = 'private source' },
    value => { value.stages[0] = { name: 'platform', exit: 0, output: 'private source' } },
    value => { value.stages.pop() },
    value => { value.stages[0].exit = 1 },
    value => { value.stages[0].name = 'private-source-text' },
    value => { value.artifactSha256 = 'invalid' },
    value => { value.publicMainCompatibilitySha = 'main' },
    value => { value.databaseIntegration = 'external' },
    value => { value.imageRuntimeExecutor = 'host' },
    value => { value.publication = 'published' },
    value => { value.version = 2 },
  ]) {
    const changed = structuredClone(receipt(context))
    mutate(changed)
    assert.throws(() => verifyPublicReceipt(changed, context), /RECEIPT_/)
  }
  assert.throws(() => verifyPublicReceipt({ excluded: true }, context), /RECEIPT_/)
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

test('pinned private helper receives original Actions context and only publish writes the receipt artifact', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-public-cloud-ci-'))
  const logs = []
  t.mock.method(console, 'log', line => logs.push(line))
  try {
    const publicRoot = join(directory, 'public')
    const publicSource = await repository(publicRoot, 'alexj11324/Mikka', { '.gitignore': '/.mikka-cloud/\n' })
    git(publicRoot, 'remote', 'set-url', 'origin', 'https://x-access-token:private-sentinel@github.com/ALEXJ11324/mikka.git')
    const privateRoot = join(publicRoot, '.mikka-cloud')
    const privateSource = await repository(privateRoot, 'alexj11324/mikka-cloud', {
      'scripts/cloudflare-ci.mjs': `import { execFileSync } from 'node:child_process'
      export async function runCi({ env, verify, publicRoot, publicSource }) {
        if (!publicRoot || publicSource !== env.GITHUB_SHA || env.GITHUB_ACTIONS !== 'true' || env.WORKERS_CI) throw new Error('missing public owner')
        if (env.MIKKA_TEST_SOURCE_DRIFT) execFileSync('git', ['-c', 'user.name=CI Fixture', '-c', 'user.email=ci@example.test', 'commit', '--allow-empty', '-m', 'source drift'], { cwd: publicRoot, stdio: 'pipe' })
        return { version: 1, qualifiedArtifact: { privateSource: env.MIKKA_CLOUD_SOURCE_SHA, modelSource: '${'e'.repeat(40)}', publicSource, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, localImageId: 'sha256:${'f'.repeat(64)}', workerDigest: '${'1'.repeat(64)}', manifestSha256: '${'2'.repeat(64)}' }, publication: 'none', publicMainCompatibilitySha: '${'c'.repeat(40)}',
          artifactSha256: '${'d'.repeat(64)}', databaseIntegration: 'isolated-postgresql-17-core-models-and-eve',
          imageRuntimeExecutor: 'image-files-node24', stages: ${JSON.stringify(stages)}, context: {
            provider: 'github-actions', repository: env.GITHUB_REPOSITORY, publicSource,
            sha: env.MIKKA_CLOUD_SOURCE_SHA, branch: 'main', ref: env.GITHUB_REF,
            workflowRef: env.GITHUB_WORKFLOW_REF, workflowSha: env.GITHUB_WORKFLOW_SHA,
            runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, actorId: env.GITHUB_ACTOR_ID,
            buildId: env.MIKKA_TEST_RECEIPT_DRIFT ? 'private-build' : env.GITHUB_RUN_ID + '-' + env.GITHUB_RUN_ATTEMPT,
          } }
      }`,
      'scripts/cloudflare-ci-publish.mjs': `export async function publishQualifiedCloud(options) {
        const { runCi } = await import('./cloudflare-ci.mjs')
        const receipt = await runCi(options)
        const reference = 'registry.cloudflare.com/d8f6630c7869111a5139bc5ed4d24ace/mikka-cloud-services@sha256:${'3'.repeat(64)}'
        return { receipt, cloudArtifact: { ...receipt.qualifiedArtifact, image: reference, reference, registryDigest: 'sha256:${'3'.repeat(64)}' } }
      }`,
    })
    const buildEnv = { ...env, GITHUB_SHA: publicSource, GITHUB_WORKFLOW_SHA: publicSource,
      MIKKA_CLOUD_SOURCE_SHA: privateSource, RUNNER_TEMP: join(directory, 'runner') }
    const artifactDirectory = join(buildEnv.RUNNER_TEMP, 'cloud-services-ci-receipt')
    await runCloudCi({ env: buildEnv, publicRoot })
    assert.equal(existsSync(artifactDirectory), false)
    assert.equal(logs.some(line => line.startsWith('MIKKA_GITHUB_CLOUD_CI_RECEIPT=')), false)
    await runCloudCi({ env: buildEnv, publicRoot, verify: true })
    assert.equal(existsSync(artifactDirectory), false)
    const result = await runCloudCi({ env: buildEnv, publicRoot, verify: true, publish: true })
    const reference = 'registry.cloudflare.com/d8f6630c7869111a5139bc5ed4d24ace/mikka-cloud-services@sha256:' + '3'.repeat(64)
    const artifact = { version: 1, context: result.context, receipt: result.receipt,
      cloudArtifact: { ...result.receipt.qualifiedArtifact, image: reference, reference, registryDigest: 'sha256:' + '3'.repeat(64) }, publication: 'registry-only' }
    assert.deepEqual(await readdir(artifactDirectory), ['receipt.json'])
    assert.deepEqual(JSON.parse(await readFile(join(artifactDirectory, 'receipt.json'), 'utf8')), artifact)
    const markers = logs.filter(line => line.startsWith('MIKKA_GITHUB_CLOUD_CI_RECEIPT='))
    assert.equal(markers.length, 1)
    assert.deepEqual(JSON.parse(markers[0].slice('MIKKA_GITHUB_CLOUD_CI_RECEIPT='.length)), artifact)
    assert.equal(logs.some(line => line.includes('private-sentinel')), false)
    await assert.rejects(runCloudCi({ env: { ...buildEnv, MIKKA_TEST_RECEIPT_DRIFT: '1' }, publicRoot }), /RECEIPT_SOURCE_MISMATCH/)
    await assert.rejects(runCloudCi({ env: { ...buildEnv, RUNNER_TEMP: '' }, publicRoot, verify: true, publish: true }), /RUNNER_TEMP_REQUIRED/)
    await assert.rejects(runCloudCi({ env: { ...buildEnv, MIKKA_CLOUD_SOURCE_SHA: 'c'.repeat(40) }, publicRoot }), /PRIVATE_SOURCE_MISMATCH/)
    await assert.rejects(runCloudCi({ env: { ...buildEnv, MIKKA_TEST_SOURCE_DRIFT: '1' }, publicRoot }), /SOURCE_CHANGED/)
    git(publicRoot, 'reset', '--hard', publicSource)
    await writeFile(join(privateRoot, 'scripts/cloudflare-ci.mjs'), 'throw new Error("dirty compiler executed")')
    await assert.rejects(runCloudCi({ env: buildEnv, publicRoot }), /PRIVATE_SOURCE_MISMATCH/)
    git(publicRoot, 'remote', 'set-url', 'origin', 'https://github.com/alexj11324/mikka-cloud.git')
    await assert.rejects(runCloudCi({ env: buildEnv, publicRoot }), /REPOSITORY_REQUIRED/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('workflow uses public manual main qualification and uploads the single receipt file', async () => {
  const workflow = await readFile(new URL('../.github/workflows/cloud-services-ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /on:\n  workflow_dispatch:\n    inputs:\n      cloud_source_sha:/)
  assert.match(workflow, /permissions:\n  contents: read\njobs:/)
  assert.match(workflow, /if: github.repository == 'alexj11324\/Mikka' && github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/main'/)
  assert.match(workflow, /runs-on: ubuntu-latest/)
  assert.match(workflow, /node-version: 24\.22\.1/)
  assert.match(workflow, /corepack prepare pnpm@10\.34\.3 --activate/)
  assert.match(workflow, /MIKKA_CLOUD_SOURCE_SHA: \$\{\{ inputs.cloud_source_sha }}/)
  assert.match(workflow, /MIKKA_CLOUD_READ_TOKEN: \$\{\{ secrets.MIKKA_CLOUD_READ_TOKEN }}/)
  assert.match(workflow, /name: Qualify the pinned Cloud Services source[\s\S]*run: node scripts\/cloudflare-cloud-ci.mjs build/)
  assert.match(workflow, /name: Verify the Cloud Services qualification\n        run: node scripts\/cloudflare-cloud-ci.mjs verify/)
  assert.match(workflow, /name: Upload the qualification receipt/)
  assert.match(workflow, /name: cloud-services-ci-receipt-\$\{\{ github.run_id }}-\$\{\{ github.run_attempt }}/)
  assert.match(workflow, /path: \$\{\{ runner.temp }}\/cloud-services-ci-receipt\/receipt.json\n          if-no-files-found: error/)
  assert.equal((workflow.match(/actions\/upload-artifact@/g) ?? []).length, 1)
  assert.match(workflow, /environment: cloudflare-runtime-release/)
  assert.match(workflow, /CF_RUNTIME_REGISTRY_USERNAME: \$\{\{ vars\.CF_RUNTIME_REGISTRY_USERNAME }}/)
  assert.match(workflow, /name: Publish the qualified Cloud Services artifact[\s\S]*CF_RUNTIME_REGISTRY_USERNAME:[\s\S]*CF_RUNTIME_REGISTRY_PASSWORD:[\s\S]*run: node scripts\/cloudflare-cloud-ci.mjs publish/)
  assert.ok(workflow.indexOf('name: Verify the Cloud Services qualification') < workflow.indexOf('name: Publish the qualified Cloud Services artifact'))
  assert.doesNotMatch(workflow, /pull_request:|push:|WORKERS_CI|create-github-app-token|CLOUDFLARE_API_TOKEN/)
})

test('CLI reports fixed errors without raw failure values', () => {
  const script = fileURLToPath(new URL('./cloudflare-cloud-ci.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, 'private-sentinel'], { cwd: dirname(script), encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.equal(result.stderr.trim(), 'CLOUD_PUBLIC_CI_ARGUMENT_INVALID')
  assert.equal(result.stdout, '')
})


test('published metadata contains exactly the qualified sources, hashes and immutable Registry reference', () => {
  const context = sourceContext(env, env.GITHUB_SHA)
  const inner = receipt(context)
  const reference = 'registry.cloudflare.com/d8f6630c7869111a5139bc5ed4d24ace/mikka-cloud-services@sha256:' + '3'.repeat(64)
  const artifact = { ...inner.qualifiedArtifact, image: reference, reference, registryDigest: reference.split('@')[1] }
  assert.equal(verifyPublishedArtifact(artifact, inner, context), artifact)
  for (const key of Object.keys(artifact)) {
    assert.throws(() => verifyPublishedArtifact({ ...artifact, [key]: 'changed' }, inner, context))
  }
  assert.throws(() => verifyPublishedArtifact({ ...artifact, privateLogs: 'hidden' }, inner, context))
})
