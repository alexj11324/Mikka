import { spawnSync, execFileSync } from 'node:child_process'
import { createPrivateKey } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

export function validateNativeBuild(parsed, { sourceSha, buildId, driverSha }, app) {
  const builds = Array.isArray(parsed) ? parsed : [parsed]
  const build = builds.find(item => item?.platform === 'IOS')
  if (!build || !UUID.test(build.id ?? '') || build.status !== 'FINISHED' ||
      build.gitCommitHash !== sourceSha || (buildId && build.id !== buildId) ||
      build.app?.id !== app.extra?.eas?.projectId || build.appIdentifier !== app.ios?.bundleIdentifier ||
      build.buildProfile !== 'production' || build.distribution !== 'STORE' || build.isForIosSimulator === true) {
    throw Error('nativeBuildIdentityMismatch')
  }
  if (!build.runtime?.version || !build.fingerprint?.hash ||
      (app.runtimeVersion?.policy === 'fingerprint' && build.runtime.version !== build.fingerprint.hash)) {
    throw Error('nativeBuildRuntimeUnverified')
  }
  const fields = ['id', 'platform', 'status', 'gitCommitHash', 'appVersion', 'appBuildVersion', 'buildProfile', 'createdAt', 'completedAt']
  return { ...Object.fromEntries(fields.map(key => [key, build[key] ?? null])), driverSha,
    runtimeVersion: build.runtime.version, fingerprint: build.fingerprint.hash }
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
    }, null, 2) + '\n')
    appendFileSync(env.GITHUB_OUTPUT, `commit=${source.sourceSha}\nbuild_id=${source.buildId}\n`)
  } else if (mode === 'credentials') {
    requireAscInputs(env)
    console.log('Existing App Store Connect credential inputs are configured.')
  } else if (mode === 'verify') {
    const parsed = JSON.parse(readFileSync(join(env.RUNNER_TEMP, 'mikka-native-build.json'), 'utf8'))
    const app = JSON.parse(readFileSync('apps/mobile/app.json', 'utf8')).expo
    const report = validateNativeBuild(parsed, { sourceSha: env.NATIVE_SOURCE_SHA,
      buildId: env.EXISTING_BUILD_ID, driverSha: env.GITHUB_SHA }, app)
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
  } else throw Error('nativeReleaseModeRequired')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2])
}
