import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { sourceContext } from './cloudflare-ci.mjs'
import { buildEnvironment, digestFromRepoDigests, releaseDockerfile, releaseId, releaseSelection, validatePrepared, publicReceipt } from './cloudflare-native-oci.mjs'

const publicSha = 'a'.repeat(40)
const privateSha = 'b'.repeat(40)
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REPOSITORY_ID: '1427517699',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: publicSha,
  GITHUB_WORKFLOW_SHA: publicSha, GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/cloudflare-api-image.yml@refs/heads/main',
  GITHUB_RUN_ID: '90001', GITHUB_RUN_ATTEMPT: '2', GITHUB_ACTOR: 'alexj11324', GITHUB_ACTOR_ID: '183887963',
  GITHUB_TRIGGERING_ACTOR: 'alexj11324', OVERLAY_SHA: privateSha }
const context = sourceContext(env, publicSha, privateSha)
const receipt = { version: 1, context, provider: context.provider, publicSha, privateSha, target: 'native-api', publication: 'none',
  overlayCheckout: { repository: 'alexj11324/mikka-hosted-ui', requestedSha: privateSha, actualSha: privateSha },
  stages: ['public-install', 'private-install', 'script-tests'].map(name => ({ name, exit: 0 })) }
const selected = releaseSelection(env, receipt)
const digest = 'sha256:' + 'c'.repeat(64)
const settings = { NEXT_PUBLIC_POSTHOG_KEY: 'public-analytics', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_public',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'public-turnstile', NEXT_PUBLIC_COMPUTER_ENABLED: '1' }
const snapshot = { publicSha, privateSha, publication: 'registry-only', ...settings }
const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
const workerBundles = {
  apiIngress: { path: 'ingress.mjs', sha256: 'c'.repeat(64), bytes: 120 },
  eveRuntime: { path: 'workers/eve-runtime.mjs', sha256: 'd'.repeat(64), bytes: 220 },
  taskSandbox: { path: 'workers/task-sandbox.mjs', sha256: 'e'.repeat(64), bytes: 320 },
  web: { path: 'workers/web.mjs', sha256: 'f'.repeat(64), bytes: 420 },
  credentialIdentity: { path: 'workers/credential-identity.mjs', sha256: '1'.repeat(64), bytes: 520 },
  credentialBroker: { path: 'workers/credential-broker.mjs', sha256: '2'.repeat(64), bytes: 620 },
}

test('publication requires the public main build and exact selected overlay', () => {
  assert.equal(selected.publicSha, publicSha)
  assert.equal(selected.privateSha, privateSha)
  assert.ok(releaseId(publicSha, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT).length <= 32)
  assert.equal(releaseSelection(env, receipt).context.publicSha, publicSha)
  assert.throws(() => releaseSelection({ ...env, GITHUB_REF: 'refs/heads/feature' }, receipt), /CI_MANUAL_MAIN_REQUIRED/)
  assert.throws(() => releaseSelection(env, { ...receipt, publicSha: privateSha }), /CI_RECEIPT_INVALID/)
  assert.throws(() => releaseSelection({ ...env, GITHUB_RUN_ATTEMPT: '3' }, receipt), /CI_RECEIPT_SOURCE_MISMATCH/)
  assert.throws(() => releaseSelection(env, { ...receipt, target: 'renderers' }), /CI_BUILD_TARGET_INVALID/)
})

test('production compilation receives public settings and no read key', () => {
  const built = buildEnvironment({ ...env, HOSTED_UI_READ_KEY: 'private', API_PUBLIC_BUILD_SETTINGS: JSON.stringify(settings) }, publicSha, privateSha, selected.id)
  assert.equal(built.MIKKA_UI_OVERLAY_DIR, '.hosted-ui')
  assert.equal(built.MIKKA_BUILD_REVISION, publicSha)
  assert.equal(built.MIKKA_DEPLOYMENT_ID, selected.id)
  assert.equal(built.HOSTED_UI_READ_KEY, undefined)
  assert.throws(() => buildEnvironment({}, publicSha, privateSha, selected.id), /CF_OCI_PUBLIC_BUILD_SETTINGS_REQUIRED/)
})

test('prepared image evidence and registry digest remain bound to this build', () => {
  const prepared = { version: 1, context, publicSha, privateSha, id: selected.id, localImageId: digest, webRenderer: 'd'.repeat(64),
    workerDigest: digest, workerBundles, webArchiveSha256: 'e'.repeat(64), webArchiveBytes: 10,
    brokerLocalImageId: digest, brokerOfflineVerification: 'docker-network-none',
    offlineVerification: 'buildkit-network-none', publicBuildSettings: snapshot, publicBuildSettingsSha256: snapshotHash, publication: 'none' }
  assert.equal(validatePrepared(prepared, selected), prepared)
  assert.throws(() => validatePrepared({ ...prepared, privateSha: publicSha }, selected), /CF_OCI_PREPARED_MISMATCH/)
  for (const broker of [{ brokerLocalImageId: 'tag-only' }, { brokerOfflineVerification: 'skipped' }]) {
    assert.throws(() => validatePrepared({ ...prepared, ...broker }, selected), /CF_OCI_PREPARED_MISMATCH/)
  }
  for (const bundles of [undefined, { ...workerBundles, extra: workerBundles.web },
    { ...workerBundles, web: undefined }, { ...workerBundles, web: { ...workerBundles.web, path: '../web.mjs' } },
    { ...workerBundles, web: { ...workerBundles.web, bytes: 0 } },
    { ...workerBundles, apiIngress: { ...workerBundles.apiIngress, sha256: '0'.repeat(64) } }]) {
    assert.throws(() => validatePrepared({ ...prepared, workerBundles: bundles }, selected), /CF_OCI_WORKER_BUNDLES_INVALID/)
  }
  const account = 'f'.repeat(32)
  const printed = 'registry.cloudflare.com/' + account + '/mikka-api@' + digest + '\n'
  assert.equal(digestFromRepoDigests(printed + printed, account, selected.id).digest, digest)
  const brokerRef = 'registry.cloudflare.com/' + account + '/mikka-credential-broker@' + digest
  assert.equal(digestFromRepoDigests(printed + brokerRef, account, selected.id, 'mikka-credential-broker').image, brokerRef)
  assert.throws(() => digestFromRepoDigests(printed, account, selected.id, 'mikka-credential-broker'), /CF_OCI_REGISTRY_DIGEST_UNVERIFIED/)
  assert.throws(() => digestFromRepoDigests('', account, selected.id), /CF_OCI_REGISTRY_DIGEST_UNVERIFIED/)
  assert.ok(releaseDockerfile('FROM node:24').includes('RUN --network=none'))
})

test('private child output never reaches public logs while stage and failure metadata remain', () => {
  const privateCode = 'export const PrivateFixtureWidget = "fixture-sensitive-value"'
  const module = new URL('./cloudflare-native-oci.mjs', import.meta.url).href
  const child = `process.stdout.write(${JSON.stringify(privateCode)}); process.stderr.write(${JSON.stringify(privateCode)}); process.exit(23)`
  const harness = `import { command } from ${JSON.stringify(module)};
    try { command(process.execPath, ['-e', ${JSON.stringify(child)}], { stage: 'PRIVATE_FIXTURE', stdio: 'inherit' }) } catch {}
    try { command('/nonexistent/mikka-fixture-command', [], { stage: 'MISSING_FIXTURE' }) } catch {}`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', harness], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  const output = result.stdout + result.stderr
  assert.ok(!output.includes(privateCode))
  assert.ok(!output.includes('fixture-sensitive-value'))
  const events = output.trim().split(/\r?\n/).map(line => JSON.parse(line.slice('MIKKA_CF_OCI_STAGE='.length)))
  const failures = events.filter(event => event.status === 'failed')
  assert.equal(failures.length, 2)
  assert.equal(failures[0].stage, 'PRIVATE_FIXTURE')
  assert.equal(failures[0].exit, 23)
  assert.equal(failures[1].code, 'ENOENT')
  for (const failure of failures) {
    assert.deepEqual(Object.keys(failure).sort(), ['code', 'elapsedMs', 'exit', 'stage', 'status'])
    assert.ok(Number.isSafeInteger(failure.elapsedMs) && failure.elapsedMs >= 0)
  }
})

test('API publication compiles in the public root once without runtime image coupling', async () => {
  const source = await readFile(new URL('./cloudflare-native-oci.mjs', import.meta.url), 'utf8')
  assert.equal(source.match(/buildProduct\(work, env\)/g).length, 2)
  assert.ok(source.includes('const work = root'))
  assert.ok(!source.includes('productionWorkspace'))
  assert.ok(!source.includes('prepareRuntime'))
  assert.ok(!source.includes('publishRuntime'))
})


test('build settings are captured in the artifact and authenticated through a value-free log projection', () => {
  const artifact = { version: 1, publicSha, publicBuildSettings: snapshot, publicBuildSettingsSha256: snapshotHash }
  const logged = publicReceipt(artifact)
  assert.equal(logged.publicBuildSettings, undefined)
  assert.equal(logged.publicBuildSettingsSha256, snapshotHash)
  assert.ok(!JSON.stringify(logged).includes(settings.NEXT_PUBLIC_POSTHOG_KEY))
  assert.equal(artifact.publicBuildSettings, snapshot)
  for (const value of ['not-json', '{}', JSON.stringify({ ...settings, EXTRA: 'unexpected' }), JSON.stringify({ ...settings, NEXT_PUBLIC_COMPUTER_ENABLED: 1 })]) {
    assert.throws(() => buildEnvironment({ API_PUBLIC_BUILD_SETTINGS: value }, publicSha, privateSha, selected.id), /CF_OCI_PUBLIC_BUILD_SETTINGS_REQUIRED/)
  }
})
