import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { requireAscInputs, selectNativeSource, validateNativeBuild, withAscProfile, verifyHostedArchive, excludedFromNativeArchive, recoverOriginalBuild } from './mobile-native.mjs'

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
  app: { id: PROJECT }, appIdentifier: app.ios.bundleIdentifier, buildProfile: 'hosted-production',
  distribution: 'STORE', isForIosSimulator: false, runtime: { version: RUNTIME }, fingerprint: { hash: RUNTIME },
  artifacts: { buildUrl: 'https://example.invalid/private-download' } }
const archiveProof = { sourceSha: SOURCE, overlaySha: 'a'.repeat(40), archiveDigest: 'b'.repeat(64), files: 10,
  overlayFiles: 3, profile: 'hosted-production', stage: 'eas build:inspect archive' }
const recovery = { originalRunId: 432, buildId: BUILD, sourceSha: SOURCE, fingerprint: RUNTIME, archiveProof }
const identity = { sourceSha: SOURCE, buildId: BUILD, driverSha: DRIVER, archiveProof, recovery }

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


test('a new store binary always requires the official profile and complete archive proof', () => {
  const fresh = { sourceSha: SOURCE, driverSha: SOURCE, buildId: '', archiveProof }
  assert.throws(() => validateNativeBuild({ ...build, buildProfile: 'production' }, fresh, app), /nativeBuildIdentityMismatch/)
  for (const patch of [undefined, { ...archiveProof, sourceSha: DRIVER }, { ...archiveProof, profile: 'production' },
    { ...archiveProof, overlayFiles: 0 }]) {
    assert.throws(() => validateNativeBuild(build, { ...fresh, archiveProof: patch }, app), /hostedBuildArchiveProofRequired/)
  }
  assert.deepEqual(validateNativeBuild(build, fresh, app).archiveProof, archiveProof)
})

function recoveryFixture() {
  const repository = { full_name: baseEnv.GITHUB_REPOSITORY, id: 1427517699 }
  const workflow = { id: 71, path: '.github/workflows/mobile-native.yml' }
  const origin = { id: 432, repository_id: repository.id, head_repository_id: repository.id, head_sha: SOURCE, head_branch: 'main' }
  const artifact = { name: 'mobile-native-' + SOURCE, expired: false, workflow_run: origin }
  const run = { id: origin.id, workflow_id: workflow.id, path: workflow.path, repository, head_repository: repository,
    head_sha: SOURCE, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'failure' }
  const steps = ['Require the complete protected UI in the EAS archive', 'Build iOS with existing signing credentials',
    'Verify the completed build and commit'].map(name => ({ name, conclusion: 'success' }))
  const reports = { build: { ...build, driverSha: SOURCE, runtimeVersion: RUNTIME, fingerprint: RUNTIME, archiveProof }, archive: { ...archiveProof } }
  const source = selectNativeSource({ ...baseEnv, EXPECTED_BUILD_COMMIT: SOURCE, EXISTING_BUILD_ID: BUILD }, () => true)
  const calls = []
  function recover(otherBuildFirst = false) {
    return recoverOriginalBuild(source, baseEnv, {
      api(path, paged) {
        const root = '/repos/alexj11324/Mikka/actions'
        if (path === root + '/workflows/mobile-native.yml') return workflow
        if (path === root + '/artifacts?name=' + artifact.name + '&per_page=100' && paged) return [{ artifacts: otherBuildFirst ? [{ ...artifact, workflow_run: { ...origin, id: 431 } }] : [] }, { artifacts: [artifact] }]
        if (otherBuildFirst && path === root + '/runs/431') return { ...run, id: 431 }
        if (path === root + '/runs/432') return run
        if ([431, 432].some(id => path === root + '/runs/' + id + '/jobs?filter=all&per_page=100') && paged) return [{ jobs: [{ steps }] }]
        throw Error('unexpected GitHub request')
      },
      readReports(id, name) { calls.push([id, name]); return id === 431 ? { ...reports, build: { ...reports.build, id: PROJECT } } : reports },
    })
  }
  return { workflow, run, artifact, origin, steps, reports, calls, recover }
}

test('recovery finds the original build on later pages, even after a failed submission, and binds the current EAS fingerprint', () => {
  const f = recoveryFixture()
  const original = f.recover(true)
  assert.deepEqual(original, recovery)
  assert.deepEqual(f.calls, [[431, 'mobile-native-' + SOURCE], [432, 'mobile-native-' + SOURCE]])
  const result = validateNativeBuild(build, { ...identity, recovery: original }, app)
  assert.equal(result.originalRunId, 432)
  assert.equal(result.archiveProof.overlaySha, archiveProof.overlaySha)
  const laterRuntime = 'e'.repeat(40)
  assert.throws(() => validateNativeBuild({ ...build, runtime: { version: laterRuntime }, fingerprint: { hash: laterRuntime } }, identity, app), /nativeOriginalBuildIdentityMismatch/)
  assert.throws(() => validateNativeBuild(build, { ...identity, recovery: undefined }, app), /nativeOriginalBuildIdentityMismatch/)
})

test('foreign, stale, incomplete and recovery-only runs never supply original archive evidence', () => {
  for (const alter of [
    f => { f.artifact.expired = true }, f => { f.origin.head_repository_id++ }, f => { f.origin.id = Number(baseEnv.GITHUB_RUN_ID) },
    f => { f.run.workflow_id++ }, f => { f.run.path = '.github/workflows/other.yml' }, f => { f.run.head_branch = 'release' },
    f => { f.run.head_sha = DRIVER }, f => { f.run.event = 'pull_request_target' }, f => { f.run.head_repository = { id: 9 } },
    f => { f.steps[1].conclusion = 'skipped' }, f => { f.reports.archive = null }, f => { f.reports.build.id = PROJECT },
    f => { f.reports.build.originalRunId = 99 },
  ]) {
    const f = recoveryFixture(); alter(f)
    assert.throws(f.recover, /nativeOriginalBuildProofRequired/)
  }
  for (const patch of [{ gitCommitHash: DRIVER }, { driverSha: DRIVER }, { buildProfile: 'production' }, { fingerprint: DRIVER }]) {
    const f = recoveryFixture(); Object.assign(f.reports.build, patch)
    assert.throws(f.recover, /nativeOriginalBuildIdentityMismatch/)
  }
  for (const patch of [{ overlaySha: DRIVER }, { archiveDigest: '3'.repeat(64) }]) {
    const f = recoveryFixture(); Object.assign(f.reports.archive, patch)
    assert.throws(f.recover, /nativeOriginalArchiveMismatch/)
  }
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
    const profiles = { production: { env: { MIKKA_MOBILE_OVERLAY_DIR: '.hosted-ui/mobile' } },
      'hosted-production': { extends: 'production', env: { MIKKA_MOBILE_OVERLAY_DIR: '.hosted-ui/mobile' } } }
    write(archive, 'apps/mobile/eas.json', JSON.stringify({ build: profiles }))
    const check = () => verifyHostedArchive({ archive, overlay, trackedFiles: [...files, 'docs/private.md'], sourceSha: SOURCE, overlaySha: DRIVER })
    write(archive, 'apps/mobile/eas.json', JSON.stringify({ build: { ...profiles, production: {} } }))
    assert.throws(check, /officialStoreOverlayRequired/)
    write(archive, 'apps/mobile/eas.json', JSON.stringify({ build: profiles }))
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
  assert.equal(eas.build.production.env.MIKKA_MOBILE_OVERLAY_DIR, '.hosted-ui/mobile')
  assert.equal(eas.build['hosted-production'].extends, 'production')
  assert.equal(eas.build['hosted-production'].env.MIKKA_MOBILE_OVERLAY_DIR, '.hosted-ui/mobile')
  const ignore = readFileSync(new URL('.easignore', root), 'utf8')
  assert.ok(ignore.startsWith(readFileSync(new URL('.gitignore', root), 'utf8')))
  assert.ok(ignore.includes('!/.hosted-ui/**'))
  const workflow = readFileSync(new URL('.github/workflows/mobile-native.yml', root), 'utf8')
  assert.ok(workflow.indexOf('mobile-native.mjs recover') > workflow.indexOf('mobile-native.mjs source'))
  assert.ok(workflow.indexOf('mobile-native.mjs recover') < workflow.indexOf('Read existing EXPO_TOKEN'))
  assert.ok(!workflow.includes('NATIVE_BUILD_PROFILE'))
  assert.ok(workflow.indexOf('mobile-native.mjs source') < workflow.indexOf('Read existing HOSTED_UI_READ_KEY'))
  assert.ok(workflow.indexOf('mobile-native.mjs archive') < workflow.indexOf('build --platform ios --profile hosted-production'))
  assert.ok(workflow.includes('ssh-key: ${{ env.HOSTED_UI_READ_KEY }}'))
  assert.ok(workflow.includes("echo 'HOSTED_UI_READ_KEY='"))
})
