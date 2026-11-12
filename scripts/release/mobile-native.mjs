import { spawnSync, execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createHash, createPrivateKey } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { releaseIdentity, waitForReleaseChecks } from './ci-gate.mjs'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const SHA = /^[a-f0-9]{40}$/
const ASC_KEYS = ['APPLE_API_KEY_P8_BASE64', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']

export function selectNativeSource(env, isAncestor = (source, driver) => {
  try { execFileSync('git', ['merge-base', '--is-ancestor', source, driver], { stdio: 'ignore' }); return true }
  catch { return false }
}) {
  const identity = releaseIdentity(env)
  const buildId = env.EXISTING_BUILD_ID ?? ''
  const expectedCommit = env.EXPECTED_BUILD_COMMIT ?? ''
  if (!buildId && !expectedCommit) return { identity, sourceSha: identity.sha, buildId: '' }
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || !UUID.test(buildId) || !SHA.test(expectedCommit)) {
    throw Error('existingBuildRequiresDispatchIdAndExactCommit')
  }
  if (!isAncestor(expectedCommit, identity.sha)) throw Error('existingBuildCommitMustBeOnMain')
  return { identity, sourceSha: expectedCommit, buildId }
}

export function requireAscInputs(env) {
  const missing = ASC_KEYS.filter(name => !env[name])
  if (missing.length) throw Error(`existingAscCredentialsMissing:${missing.join(',')}`)
  if (!/^[A-Z0-9]{1,30}$/.test(env.APPLE_API_KEY_ID) || !UUID.test(env.APPLE_API_ISSUER.toLowerCase())) {
    throw Error('existingAscCredentialIdentifiersInvalid')
  }
}

const NATIVE_WORKFLOW = '.github/workflows/mobile-native.yml'
const OFFICIAL_PROFILE = 'hosted-production'

function requireArchiveProof(archive, sourceSha) {
  assert.ok(archive?.sourceSha === sourceSha && SHA.test(archive.overlaySha ?? '') &&
    /^[a-f0-9]{64}$/.test(archive.archiveDigest ?? '') && Number.isSafeInteger(archive.overlayFiles) &&
    Number.isSafeInteger(archive.files) && archive.overlayFiles > 0 && archive.files >= archive.overlayFiles &&
    archive.profile === OFFICIAL_PROFILE && archive.stage === 'eas build:inspect archive', 'hostedBuildArchiveProofRequired')
}

function readOriginalReports(runId, name, env) {
  const directory = mkdtempSync(join(env.RUNNER_TEMP, 'mikka-native-proof-'))
  try {
    execFileSync('gh', ['run', 'download', String(runId), '--repo', env.GITHUB_REPOSITORY, '--name', name, '--dir', directory], { stdio: 'ignore' })
    const read = file => existsSync(join(directory, file)) ? JSON.parse(readFileSync(join(directory, file), 'utf8')) : null
    return { build: read('build.json'), archive: read('archive.json') }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function recoverOriginalBuild(source, env, {
  api = (path, paged = false) => JSON.parse(execFileSync('gh', ['api', ...(paged ? ['--paginate', '--slurp'] : []), path], { encoding: 'utf8' })),
  readReports = (id, name) => readOriginalReports(id, name, env),
} = {}) {
  const { repository, runId } = source.identity
  const { sourceSha, buildId } = source
  assert.ok(UUID.test(buildId) && SHA.test(sourceSha), 'nativeOriginalBuildProofRequired')
  const path = '/repos/' + repository + '/actions'
  const name = 'mobile-native-' + sourceSha
  const workflow = api(path + '/workflows/mobile-native.yml')
  assert.ok(workflow.path === NATIVE_WORKFLOW && Number.isSafeInteger(workflow.id), 'nativeOriginWorkflowRequired')
  const pages = api(path + '/artifacts?name=' + name + '&per_page=100', true)
  for (const artifact of pages.flatMap(page => page.artifacts)) {
    const origin = artifact.workflow_run
    if (artifact.name !== name || artifact.expired !== false || !Number.isSafeInteger(origin?.id) ||
        origin.repository_id !== 1427517699 || origin.head_repository_id !== 1427517699 ||
        origin.head_sha !== sourceSha || origin.head_branch !== 'main' || String(origin.id) === String(runId)) continue
    const run = api(path + '/runs/' + origin.id)
    if (run.id !== origin.id || run.workflow_id !== workflow.id || run.path !== NATIVE_WORKFLOW ||
        run.repository?.full_name !== repository || run.repository.id !== origin.repository_id ||
        run.head_repository?.id !== origin.head_repository_id || run.head_sha !== sourceSha ||
        run.head_branch !== 'main' || !['push', 'workflow_dispatch'].includes(run.event) || run.status !== 'completed') continue
    // The build can succeed even when the following TestFlight submission fails.
    // A later recovery run is not the original build producer.
    const jobs = api(path + '/runs/' + origin.id + '/jobs?filter=all&per_page=100', true).flatMap(page => page.jobs)
    const produced = jobs.some(job => ['Require the complete protected UI in the EAS archive', 'Build iOS with existing signing credentials',
      'Verify the completed build and commit'].every(name => job.steps?.some(step => step.name === name && step.conclusion === 'success')))
    if (!produced) continue
    const { build, archive } = readReports(origin.id, name)
    if (build?.id !== buildId || !archive || build.originalRunId) continue
    assert.ok(build.driverSha === sourceSha && build.gitCommitHash === sourceSha && build.status === 'FINISHED' &&
      build.platform === 'IOS' && build.buildProfile === OFFICIAL_PROFILE && typeof build.fingerprint === 'string' &&
      build.fingerprint.length > 0 && build.runtimeVersion === build.fingerprint, 'nativeOriginalBuildIdentityMismatch')
    requireArchiveProof(archive, sourceSha)
    assert.deepEqual(build.archiveProof, archive, 'nativeOriginalArchiveMismatch')
    return { originalRunId: origin.id, buildId, sourceSha, fingerprint: build.fingerprint, archiveProof: archive }
  }
  throw Error('nativeOriginalBuildProofRequired')
}

export function validateNativeBuild(parsed, { sourceSha, buildId, driverSha, archiveProof, recovery }, app) {
  const builds = Array.isArray(parsed) ? parsed : [parsed]
  const build = builds.find(item => item?.platform === 'IOS')
  if (!build || !UUID.test(build.id ?? '') || build.status !== 'FINISHED' ||
      build.gitCommitHash !== sourceSha || (buildId && build.id !== buildId) ||
      build.app?.id !== app.extra?.eas?.projectId || build.appIdentifier !== app.ios?.bundleIdentifier ||
      build.buildProfile !== OFFICIAL_PROFILE || build.distribution !== 'STORE' || build.isForIosSimulator === true) {
    throw Error('nativeBuildIdentityMismatch')
  }
  if (typeof build.runtime?.version !== 'string' || !build.runtime.version ||
      typeof build.fingerprint?.hash !== 'string' || !build.fingerprint.hash ||
      (app.runtimeVersion?.policy === 'fingerprint' && build.runtime.version !== build.fingerprint.hash)) {
    throw Error('nativeBuildRuntimeUnverified')
  }
  requireArchiveProof(archiveProof, sourceSha)
  if (buildId) {
    assert.ok(Number.isSafeInteger(recovery?.originalRunId) && recovery?.buildId === build.id && recovery.sourceSha === sourceSha &&
      recovery.fingerprint === build.fingerprint.hash, 'nativeOriginalBuildIdentityMismatch')
    assert.deepEqual(recovery.archiveProof, archiveProof, 'nativeOriginalArchiveMismatch')
  }
  const fields = ['id', 'platform', 'status', 'gitCommitHash', 'appVersion', 'appBuildVersion', 'buildProfile', 'createdAt', 'completedAt']
  return { ...Object.fromEntries(fields.map(key => [key, build[key] ?? null])), driverSha,
    runtimeVersion: build.runtime.version, fingerprint: build.fingerprint.hash,
    archiveProof, ...(buildId ? { originalRunId: recovery.originalRunId } : {}) }
}

// These file classes are excluded by .easignore and must never cross the upload boundary.
export function excludedFromNativeArchive(path) {
  const segments = path.split('/')
  return segments.some(part => ['.git', 'node_modules', 'docs'].includes(part) || /^\.env/i.test(part)) ||
    /(?:\.map|\.pem|\.key|\.p8|\.p12)$/i.test(path) ||
    /(?:^|\/)(?:id_rsa[^/]*|id_ed25519[^/]*|credentials\.json)$/i.test(path) ||
    /^\.hosted-ui\/(?:\.next|\.output|dist|build|out)\//.test(path)
}

export function verifyHostedArchive({ archive, overlay, trackedFiles, sourceSha, overlaySha }) {
  assert.match(sourceSha, SHA)
  assert.match(overlaySha, SHA)
  const expected = trackedFiles.filter(file => !excludedFromNativeArchive(`.hosted-ui/${file}`)).sort()
  assert.ok(expected.includes('mobile/slots/bot-avatar.tsx'), 'hostedMobileSlotRequired')
  const uploaded = []
  const digest = createHash('sha256')
  let files = 0
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), path = relative(archive, file).split('\\').join('/')
      const stat = lstatSync(file)
      assert.ok(!stat.isSymbolicLink(), 'nativeArchiveSymlinkUnexpected')
      // EAS preserves empty directory placeholders for excluded contents.
      if (stat.isDirectory() && readdirSync(file).length === 0) continue
      assert.ok(!excludedFromNativeArchive(path), 'nativeArchiveExcludedFilePresent')
      if (stat.isDirectory()) { visit(file); continue }
      assert.ok(stat.isFile(), 'nativeArchiveFileRequired')
      const bytes = readFileSync(file)
      digest.update(path + '\0').update(createHash('sha256').update(bytes).digest()).update('\0')
      files++
      if (path.startsWith('.hosted-ui/')) {
        const overlayPath = path.slice('.hosted-ui/'.length)
        assert.ok(expected.includes(overlayPath), 'nativeArchiveOverlayTrackedSetMismatch')
        uploaded.push(overlayPath)
        assert.ok(readFileSync(join(overlay, overlayPath)).equals(bytes), 'nativeArchiveOverlayBytesMismatch')
      }
    }
  }
  visit(archive)
  uploaded.sort()
  assert.ok(uploaded.length === expected.length && uploaded.every((path, index) => path === expected[index]),
    'nativeArchiveOverlayTrackedSetMismatch')
  const profiles = JSON.parse(readFileSync(join(archive, 'apps/mobile/eas.json'), 'utf8')).build
  assert.equal(profiles[OFFICIAL_PROFILE]?.extends, 'production')
  for (const name of ['production', OFFICIAL_PROFILE]) {
    assert.equal(profiles[name]?.env?.MIKKA_MOBILE_OVERLAY_DIR, '.hosted-ui/mobile', 'officialStoreOverlayRequired')
  }
  return { sourceSha, overlaySha, archiveDigest: digest.digest('hex'), files, overlayFiles: expected.length,
    stage: 'eas build:inspect archive', profile: 'hosted-production' }
}

// Only this short-lived submission step receives the existing App Store secrets.
// The checkout contains placeholders, never the secret values. No key is uploaded as an artifact.
export function withAscProfile({ easPath, tempDir, env, run, parseKey = createPrivateKey }) {
  requireAscInputs(env)
  const original = readFileSync(easPath)
  const eas = JSON.parse(original)
  if (!/^\d+$/.test(eas.submit?.production?.ios?.ascAppId ?? '')) throw Error('existingAscAppIdRequired')
  const key = Buffer.from(env.APPLE_API_KEY_P8_BASE64, 'base64')
  try { if (parseKey(key).asymmetricKeyType !== 'ec') throw Error() }
  catch { throw Error('existingAscPrivateKeyInvalid') }
  const directory = join(tempDir, 'mikka-asc-submit')
  const keyPath = join(directory, 'AuthKey.p8')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  try {
    writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' })
    eas.submit['ci-existing-asc'] = { extends: 'production', ios: {
      ascApiKeyPath: '$MIKKA_ASC_KEY_PATH',
      ascApiKeyId: '$APPLE_API_KEY_ID',
      ascApiKeyIssuerId: '$APPLE_API_ISSUER',
    } }
    writeFileSync(easPath, JSON.stringify(eas, null, 2) + '\n')
    return run({ ...env, MIKKA_ASC_KEY_PATH: keyPath })
  } finally {
    try { writeFileSync(easPath, original) }
    finally { rmSync(directory, { recursive: true, force: true }) }
  }
}

async function main(mode) {
  const env = process.env
  if (mode === 'source') {
    const source = selectNativeSource(env)
    const token = env.GITHUB_TOKEN
    const driverChecks = await waitForReleaseChecks(source.identity, { token })
    const sourceChecks = source.sourceSha === source.identity.sha ? driverChecks :
      await waitForReleaseChecks({ ...source.identity, sha: source.sourceSha }, { token })
    mkdirSync('mobile-native-report', { recursive: true })
    writeFileSync('mobile-native-report/checks.json', JSON.stringify({
      driverSha: source.identity.sha, sourceSha: source.sourceSha, driverChecks, sourceChecks,
      ...(source.buildId ? { existingBuildRecovery: 'original-hosted-archive' } : {}),
    }, null, 2) + '\n')
    appendFileSync(env.GITHUB_OUTPUT, `commit=${source.sourceSha}\nbuild_id=${source.buildId}\n`)
  } else if (mode === 'recover') {
    const proof = recoverOriginalBuild(selectNativeSource(env), env)
    writeFileSync('mobile-native-report/archive.json', JSON.stringify(proof.archiveProof, null, 2) + '\n')
    writeFileSync(join(env.RUNNER_TEMP, 'mikka-native-origin.json'), JSON.stringify(proof))
  } else if (mode === 'archive') {
    const identity = releaseIdentity(env)
    assert.match(env.OVERLAY_SHA ?? '', SHA)
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), identity.sha)
    execFileSync('git', ['diff', '--quiet', 'HEAD'], { stdio: 'ignore' })
    assert.equal(execFileSync('git', ['-C', '.hosted-ui', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), env.OVERLAY_SHA)
    execFileSync('git', ['-C', '.hosted-ui', 'diff', '--quiet', 'HEAD'], { stdio: 'ignore' })
    const trackedFiles = execFileSync('git', ['-C', '.hosted-ui', 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
    const proof = verifyHostedArchive({ archive: join(env.RUNNER_TEMP, 'mikka-eas-archive'), overlay: '.hosted-ui',
      trackedFiles, sourceSha: identity.sha, overlaySha: env.OVERLAY_SHA })
    writeFileSync('mobile-native-report/archive.json', JSON.stringify(proof, null, 2) + '\n')
  } else if (mode === 'credentials') {
    requireAscInputs(env)
    console.log('Existing App Store Connect credential inputs are configured.')
  } else if (mode === 'verify') {
    const parsed = JSON.parse(readFileSync(join(env.RUNNER_TEMP, 'mikka-native-build.json'), 'utf8'))
    const app = JSON.parse(readFileSync('apps/mobile/app.json', 'utf8')).expo
    const report = validateNativeBuild(parsed, { sourceSha: env.NATIVE_SOURCE_SHA,
      buildId: env.EXISTING_BUILD_ID, driverSha: env.GITHUB_SHA,
      recovery: env.EXISTING_BUILD_ID ? JSON.parse(readFileSync(join(env.RUNNER_TEMP, 'mikka-native-origin.json'), 'utf8')) : undefined,
      archiveProof: JSON.parse(readFileSync('mobile-native-report/archive.json', 'utf8')) }, app)
    mkdirSync('mobile-native-report', { recursive: true })
    writeFileSync('mobile-native-report/build.json', JSON.stringify(report, null, 2) + '\n')
    appendFileSync(env.GITHUB_OUTPUT, `id=${report.id}\n`)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### Completed iOS build\n\nBuild: ${report.id}\n\nSource commit: ${report.gitCommitHash}\n\nWorkflow commit: ${report.driverSha}\n\nRuntime: ${report.runtimeVersion}\n\nBinary build verified. TestFlight submission, processing and device installation are separate.\n`)
  } else if (mode === 'submit') {
    if (!UUID.test(env.NATIVE_BUILD_ID ?? '')) throw Error('verifiedBuildIdRequired')
    withAscProfile({ easPath: 'apps/mobile/eas.json', tempDir: env.RUNNER_TEMP, env,
      run: submitEnv => {
        const result = spawnSync('npx', ['-y', 'eas-cli@27.2.0', 'submit', '--platform', 'ios',
          '--profile', 'ci-existing-asc', '--id', env.NATIVE_BUILD_ID, '--non-interactive', '--wait',
          '--no-auto-testflight-setup'], { cwd: 'apps/mobile', env: submitEnv, stdio: 'inherit' })
        if (result.error || result.status !== 0) throw Error('existingBuildSubmissionFailed')
      } })
  } else if (mode === 'cleanup') {
    if (!env.RUNNER_TEMP) throw Error('runnerTempRequired')
    rmSync(join(env.RUNNER_TEMP, 'mikka-asc-submit'), { recursive: true, force: true })
    rmSync(join(env.RUNNER_TEMP, 'mikka-eas-archive'), { recursive: true, force: true })
    rmSync('.hosted-ui', { recursive: true, force: true })
  } else throw Error('nativeReleaseModeRequired')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2])
}
