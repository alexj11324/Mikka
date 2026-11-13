import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { sourceContext } from './cloudflare-ci.mjs'
import { buildEnvironment, digestFromRepoDigests, redactOutput, releaseDockerfile, releaseId, releaseSelection, validatePrepared } from './cloudflare-native-oci.mjs'

const publicSha = 'a'.repeat(40)
const privateSha = 'b'.repeat(40)
const buildId = '12345678-1234-1234-1234-123456789abc'
const env = { WORKERS_CI: '1', WORKERS_CI_COMMIT_SHA: publicSha, WORKERS_CI_BRANCH: 'main', WORKERS_CI_BUILD_UUID: buildId,
  MIKKA_CF_RELEASE_PUBLIC_SHA: publicSha, MIKKA_CF_RELEASE_OVERLAY_SHA: privateSha, MIKKA_CF_RELEASE_MODE: 'registry-only' }
const context = sourceContext(env, publicSha, privateSha)
const receipt = { version: 1, context, publicSha, target: 'native-api', publication: 'none' }
const selected = releaseSelection(env, receipt)
const digest = 'sha256:' + 'c'.repeat(64)

test('publication requires the public main build and exact selected overlay', () => {
  assert.equal(selected.publicSha, publicSha)
  assert.equal(selected.privateSha, privateSha)
  assert.ok(releaseId(publicSha, buildId).length <= 32)
  assert.equal(releaseSelection(env, receipt, { publish: true }).context.publicSha, publicSha)
  assert.throws(() => releaseSelection({ ...env, WORKERS_CI_BRANCH: 'feature' }, receipt), /CF_OCI_TRUSTED_MAIN_REQUIRED/)
  assert.throws(() => releaseSelection(env, { ...receipt, publicSha: privateSha }), /CF_OCI_SOURCE_RECEIPT_MISMATCH/)
  assert.throws(() => releaseSelection({ ...env, MIKKA_CF_RELEASE_MODE: undefined }, receipt, { publish: true }), /CF_OCI_EXPLICIT_PUBLICATION_REQUIRED/)
  assert.throws(() => releaseSelection(env, { ...receipt, target: 'renderers' }), /CF_OCI_SOURCE_RECEIPT_MISMATCH/)
})

test('production compilation receives public settings and no read key', () => {
  const built = buildEnvironment({ ...env, HOSTED_UI_READ_KEY: 'private', NEXT_PUBLIC_POSTHOG_KEY: 'public-analytics', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_public', NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'public-turnstile', NEXT_PUBLIC_COMPUTER_ENABLED: '1' }, publicSha, privateSha, selected.id)
  assert.equal(built.MIKKA_UI_OVERLAY_DIR, '.hosted-ui')
  assert.equal(built.MIKKA_BUILD_REVISION, publicSha)
  assert.equal(built.MIKKA_DEPLOYMENT_ID, selected.id)
  assert.equal(built.HOSTED_UI_READ_KEY, undefined)
  assert.throws(() => buildEnvironment({}, publicSha, privateSha, selected.id), /CF_OCI_PUBLIC_BUILD_VALUE_REQUIRED/)
})

test('prepared image evidence and registry digest remain bound to this build', () => {
  const prepared = { version: 1, context, publicSha, privateSha, id: selected.id, localImageId: digest, webRenderer: 'd'.repeat(64),
    workerDigest: digest, webArchiveSha256: 'e'.repeat(64), webArchiveBytes: 10, offlineVerification: 'buildkit-network-none', publication: 'none' }
  assert.equal(validatePrepared(prepared, selected), prepared)
  assert.throws(() => validatePrepared({ ...prepared, privateSha: publicSha }, selected), /CF_OCI_PREPARED_MISMATCH/)
  const account = 'f'.repeat(32)
  const printed = 'registry.cloudflare.com/' + account + '/mikka-api@' + digest + '\n'
  assert.equal(digestFromRepoDigests(printed + printed, account, selected.id).digest, digest)
  assert.throws(() => digestFromRepoDigests('', account, selected.id), /CF_OCI_REGISTRY_DIGEST_UNVERIFIED/)
  assert.ok(releaseDockerfile('FROM node:24').includes('RUN --network=none'))
})

test('diagnostics redact credentials while retaining ordinary failure context', () => {
  const safe = redactOutput('exit 1 at 17:10 token=secret-value\nhttps://user:password@host/x', { HOSTED_UI_READ_KEY: 'secret-value' })
  assert.ok(!safe.includes('secret-value'))
  assert.ok(!safe.includes('user:password'))
  assert.ok(safe.includes('exit 1 at 17:10'))
})

test('API publication compiles in the public root once without runtime image coupling', async () => {
  const source = await readFile(new URL('./cloudflare-native-oci.mjs', import.meta.url), 'utf8')
  assert.equal(source.match(/buildProduct\(work, env\)/g).length, 2)
  assert.ok(source.includes('const work = root'))
  assert.ok(!source.includes('productionWorkspace'))
  assert.ok(!source.includes('prepareRuntime'))
  assert.ok(!source.includes('publishRuntime'))
})
