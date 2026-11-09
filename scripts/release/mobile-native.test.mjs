import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { requireAscInputs, selectNativeSource, validateNativeBuild, withAscProfile, verifyHostedArchive, excludedFromNativeArchive } from './mobile-native.mjs'

const SOURCE = 'e'.repeat(40)
const DRIVER = 'd'.repeat(40)
const BUILD = 'a9b373b6-da29-43f0-9176-25a60eae1985'
const PROJECT = '902ffab1-ed16-482e-8b83-2b7535079810'
const RUNTIME = '0ec11b32ade9dcb4bcf87a751626ec5ba9acaa2d'
const baseEnv = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: DRIVER, GITHUB_RUN_ID: '123' }
const app = { extra: { eas: { projectId: PROJECT } }, ios: { bundleIdentifier: 'com.aspectlylabs.mikka' },
  runtimeVersion: { policy: 'fingerprint' } }
const build = { id: BUILD, platform: 'IOS', status: 'FINISHED', gitCommitHash: SOURCE,
  app: { id: PROJECT }, appIdentifier: app.ios.bundleIdentifier, buildProfile: 'production',
  distribution: 'STORE', isForIosSimulator: false, runtime: { version: RUNTIME }, fingerprint: { hash: RUNTIME },
  artifacts: { buildUrl: 'https://example.invalid/private-download' } }
const identity = { sourceSha: SOURCE, buildId: BUILD, driverSha: DRIVER }

test('new build retains the actual main workflow identity', () => {
  const source = selectNativeSource(baseEnv)
  assert.equal(source.sourceSha, DRIVER)
  assert.equal(source.identity.sha, DRIVER)
  assert.equal(source.buildId, '')
})

test('existing build uses a separately verified ancestor without overwriting the workflow SHA', () => {
  const env = { ...baseEnv, EXISTING_BUILD_ID: BUILD, EXPECTED_BUILD_COMMIT: SOURCE }
  const calls = []
  const source = selectNativeSource(env, (...args) => { calls.push(args); return true })
  assert.deepEqual(calls, [[SOURCE, DRIVER]])
  assert.equal(source.sourceSha, SOURCE)
  assert.equal(source.identity.sha, DRIVER)
  assert.equal(env.GITHUB_SHA, DRIVER)
})

test('rejects incomplete, malformed, off-main and push-time recovery selectors', () => {
  for (const extra of [
    { EXISTING_BUILD_ID: BUILD },
    { EXPECTED_BUILD_COMMIT: SOURCE },
    { EXISTING_BUILD_ID: '$(false)', EXPECTED_BUILD_COMMIT: SOURCE },
    { EXISTING_BUILD_ID: BUILD, EXPECTED_BUILD_COMMIT: 'main' },
    { EXISTING_BUILD_ID: BUILD, EXPECTED_BUILD_COMMIT: SOURCE, GITHUB_EVENT_NAME: 'push' },
  ]) assert.throws(() => selectNativeSource({ ...baseEnv, ...extra }, () => true))
  assert.throws(() => selectNativeSource({ ...baseEnv, EXISTING_BUILD_ID: BUILD, EXPECTED_BUILD_COMMIT: SOURCE },
    () => false), /existingBuildCommitMustBeOnMain/)
  assert.throws(() => selectNativeSource({ ...baseEnv, GITHUB_REF: 'refs/heads/feature' }), /releaseMainIdentityRequired/)
})

test('exact completed store build produces a non-secret report with both source identities', () => {
  const report = validateNativeBuild(build, identity, app)
  assert.equal(report.id, BUILD)
  assert.equal(report.gitCommitHash, SOURCE)
  assert.equal(report.driverSha, DRIVER)
  assert.equal(report.runtimeVersion, RUNTIME)
  assert.equal(report.fingerprint, RUNTIME)
  assert.equal('artifacts' in report, false)
})

test('rejects foreign, unfinished, mismatched and simulator binaries before submission', () => {
  for (const patch of [
    { id: 'b9b373b6-da29-43f0-9176-25a60eae1985' }, { platform: 'ANDROID' },
    { status: 'IN_PROGRESS' }, { gitCommitHash: DRIVER }, { app: { id: 'another-project' } },
    { appIdentifier: 'another.bundle' }, { buildProfile: 'preview' }, { distribution: 'INTERNAL' },
    { isForIosSimulator: true },
  ]) assert.throws(() => validateNativeBuild({ ...build, ...patch }, identity, app), /nativeBuildIdentityMismatch/)
})

test('rejects absent or inconsistent fingerprint runtime evidence', () => {
  for (const patch of [{ runtime: null }, { fingerprint: null }, { runtime: { version: 'different' } }]) {
    assert.throws(() => validateNativeBuild({ ...build, ...patch }, identity, app), /nativeBuildRuntimeUnverified/)
  }
})

const fakeKey = 'synthetic-test-content-not-an-Apple-key'
const ascEnv = { APPLE_API_KEY_P8_BASE64: Buffer.from(fakeKey).toString('base64'), APPLE_API_KEY_ID: 'TEST123456',
  APPLE_API_ISSUER: '11111111-1111-4111-8111-111111111111' }

test('missing credentials report only the missing variable names', () => {
  const missing = ['APPLE_API_KEY_P8_BASE64', 'APPLE_API_ISSUER']
  assert.throws(() => requireAscInputs({ APPLE_API_KEY_ID: ascEnv.APPLE_API_KEY_ID }),
    { message: `existingAscCredentialsMissing:${missing.join(',')}` })
  assert.throws(() => requireAscInputs({ ...ascEnv, APPLE_API_ISSUER: 'bad-issuer' }), /existingAscCredentialIdentifiersInvalid/)
})

for (const failure of [false, true]) test(`temporary submit profile restores original bytes and removes key after ${failure ? 'failure' : 'success'}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mikka-native-unit-'))
  const easPath = join(dir, 'eas.json')
  const original = '{"submit":{"production":{"ios":{"ascAppId":"1234567890"}}}}\n'
  writeFileSync(easPath, original)
  let keyPath
  try {
    const submit = () => withAscProfile({ easPath, tempDir: dir, env: ascEnv,
      parseKey: bytes => { assert.equal(bytes.toString(), fakeKey); return { asymmetricKeyType: 'ec' } },
      run: env => {
        keyPath = env.MIKKA_ASC_KEY_PATH
        assert.equal(readFileSync(keyPath, 'utf8'), fakeKey)
        assert.equal(statSync(keyPath).mode & 0o777, 0o600)
        const raw = readFileSync(easPath, 'utf8')
        const profile = JSON.parse(raw).submit['ci-existing-asc']
        assert.equal(profile.extends, 'production')
        assert.equal(profile.ios.ascApiKeyPath, '$MIKKA_ASC_KEY_PATH')
        assert.equal(profile.ios.ascApiKeyId, '$APPLE_API_KEY_ID')
        assert.equal(profile.ios.ascApiKeyIssuerId, '$APPLE_API_ISSUER')
        assert.equal(raw.includes(ascEnv.APPLE_API_KEY_ID), false)
        assert.equal(raw.includes(fakeKey), false)
        if (failure) throw Error('simulatedSubmissionFailure')
        return 'submitted'
      } })
    if (failure) assert.throws(submit, /simulatedSubmissionFailure/)
    else assert.equal(submit(), 'submitted')
    assert.equal(readFileSync(easPath, 'utf8'), original)
    assert.equal(existsSync(keyPath), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('invalid P8 error does not reveal its contents or alter the checkout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mikka-native-unit-'))
  const easPath = join(dir, 'eas.json')
  const original = '{"submit":{"production":{"ios":{"ascAppId":"123"}}}}'
  writeFileSync(easPath, original)
  try {
    assert.throws(() => withAscProfile({ easPath, tempDir: dir, env: ascEnv, run: () => assert.fail('must not submit') }),
      { message: 'existingAscPrivateKeyInvalid' })
    assert.equal(readFileSync(easPath, 'utf8'), original)
    assert.equal(existsSync(join(dir, 'mikka-asc-submit')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('official profile requires a matching archive proof and never accepts it as the public profile', () => {
  const archiveProof = { sourceSha: SOURCE, overlaySha: 'a'.repeat(40), archiveDigest: 'b'.repeat(64), files: 10, overlayFiles: 3 }
  const hosted = { ...build, buildProfile: 'hosted-production' }
  assert.throws(() => validateNativeBuild(hosted, identity, app), /nativeBuildIdentityMismatch/)
  assert.throws(() => validateNativeBuild(hosted, { ...identity, expectedProfile: 'hosted-production' }, app), /hostedBuildArchiveProofRequired/)
  assert.throws(() => validateNativeBuild(hosted, { ...identity, expectedProfile: 'hosted-production', archiveProof: { ...archiveProof, sourceSha: DRIVER } }, app), /hostedBuildArchiveProofRequired/)
  const report = validateNativeBuild(hosted, { ...identity, expectedProfile: 'hosted-production', archiveProof }, app)
  assert.deepEqual(report.archiveProof, archiveProof)
})

test('archive preserves transitive tracked UI bytes and rejects missing, extra, changed or excluded files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mikka-archive-unit-'))
  const archive = join(dir, 'archive'), overlay = join(dir, 'overlay')
  const files = ['mobile/slots/bot-avatar.tsx', 'components/mikka/bot-paper.tsx']
  const write = (root, file, text) => {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  try {
    for (const file of files) {
      write(overlay, file, `synthetic ${file}`)
      write(archive, `.hosted-ui/${file}`, `synthetic ${file}`)
    }
    write(archive, 'apps/mobile/eas.json', JSON.stringify({ build: { 'hosted-production': {
      extends: 'production', env: { MIKKA_MOBILE_OVERLAY_DIR: '.hosted-ui/mobile' },
    } } }))
    const check = () => verifyHostedArchive({ archive, overlay, trackedFiles: [...files, 'docs/private.md'], sourceSha: SOURCE, overlaySha: DRIVER })
    const proof = check()
    assert.equal(proof.overlayFiles, 2)
    assert.equal(proof.files, 3)
    assert.match(proof.archiveDigest, /^[a-f0-9]{64}$/)
    mkdirSync(join(archive, 'docs'), { recursive: true })
    mkdirSync(join(archive, '.hosted-ui/docs'), { recursive: true })
    assert.equal(check().archiveDigest, proof.archiveDigest)
    rmSync(join(archive, '.hosted-ui', files[1]))
    assert.throws(check, /nativeArchiveOverlayTrackedSetMismatch/)
    copyFileSync(join(overlay, files[1]), join(archive, '.hosted-ui', files[1]))
    write(archive, '.hosted-ui/extra.tsx', 'unexpected')
    write(overlay, 'extra.tsx', 'unexpected')
    assert.throws(check, /nativeArchiveOverlayTrackedSetMismatch/)
    rmSync(join(archive, '.hosted-ui/extra.tsx'))
    write(archive, `.hosted-ui/${files[1]}`, 'changed')
    assert.throws(check, /nativeArchiveOverlayBytesMismatch/)
    copyFileSync(join(overlay, files[1]), join(archive, '.hosted-ui', files[1]))
    for (const file of ['.git/config', '.env.production', '.hosted-ui/.git/config', '.hosted-ui/.env', 'AuthKey.p8', 'bundle.js.map', 'node_modules/module.js', '.hosted-ui/docs/private.md']) {
      assert.equal(excludedFromNativeArchive(file), true)
      write(archive, file, 'synthetic blocked file')
      assert.throws(check, /nativeArchiveExcludedFilePresent/)
      rmSync(join(archive, file), { force: true })
      assert.equal(check().archiveDigest, proof.archiveDigest)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('official packaging keeps public profiles and ignored paths while adding the complete protected checkout', () => {
  const root = new URL('../../', import.meta.url)
  const eas = JSON.parse(readFileSync(new URL('apps/mobile/eas.json', root), 'utf8'))
  assert.equal(eas.build.production.env, undefined)
  assert.equal(eas.build['hosted-production'].extends, 'production')
  assert.equal(eas.build['hosted-production'].env.MIKKA_MOBILE_OVERLAY_DIR, '.hosted-ui/mobile')
  const ignore = readFileSync(new URL('.easignore', root), 'utf8')
  assert.ok(ignore.startsWith(readFileSync(new URL('.gitignore', root), 'utf8')))
  assert.ok(ignore.includes('!/.hosted-ui/**'))
  const workflow = readFileSync(new URL('.github/workflows/mobile-native.yml', root), 'utf8')
  assert.ok(workflow.indexOf('mobile-native.mjs source') < workflow.indexOf('Read existing HOSTED_UI_READ_KEY'))
  assert.ok(workflow.indexOf('mobile-native.mjs archive') < workflow.indexOf('build --platform ios --profile hosted-production'))
  assert.ok(workflow.includes('ssh-key: ${{ env.HOSTED_UI_READ_KEY }}'))
  assert.ok(workflow.includes("echo 'HOSTED_UI_READ_KEY='"))
})
