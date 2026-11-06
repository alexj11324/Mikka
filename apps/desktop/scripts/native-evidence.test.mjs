import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { auditNativeEvidence, validateNativeReport } from './native-evidence.mjs'
import { savePackageVerification } from './verify-mac-package.mjs'

// Exact closed result from macOS job 127594837473, before any account test or
// environment descriptor existed. This failed acceptance is still safe evidence.
const observedFailure = {
  version: 1, variant: 'acceptance', passed: false, signatureVerifiedStrictDeep: true,
  bundleIdentifier: 'com.aspectlylabs.mikka.dev', architecture: 'arm64',
  identity: { adHoc: true, teamIdentifier: 'none', hardenedRuntime: true, cdHash: '68f10c7d8d367382e5c9f2e19a2570cf2adb3f3a' },
  failure: 'MAC_PACKAGE_ENTITLEMENTS',
}
function validPackage() {
  const { failure: _failure, ...report } = structuredClone(observedFailure)
  return { ...report, passed: true, urlScheme: 'mikka-dev-auth', signedBundleCount: 2,
    entitlements: { hardenedRuntime: true, devOnlyLibraryValidationException: true, unexpected: false, executables: 1, libraries: 1, librariesWithoutEntitlements: 1 },
    fuses: { RunAsNode: false, EnableCookieEncryption: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: true,
      EnableEmbeddedAsarIntegrityValidation: false, OnlyLoadAppFromAsar: true, LoadBrowserProcessSpecificV8Snapshot: false, GrantFileProtocolExtraPrivileges: true } }
}
function validCrypto() {
  return { version: 1, passed: true, platform: 'darwin', architecture: 'arm64', revision: 'a'.repeat(40), package: validPackage(),
    sameImmutablePackage: true, distinctProcesses: 3, cleanup: 'passed',
    launches: ['create', 'continue', 'verify'].map((phase, index) => ({ mode: index === 1 ? 'hosted' : 'bundled', profile: index === 0 ? 'a' : 'b', phase, passed: true, processExited: true,
      crypto: { passed: true, phase, identityMatches: true, available: true, verifiedCanaries: index, encrypted: true, decrypted: true },
      keychainLog: { observation: 'after-launch-return', lookupFailureCount: 0, knownStatusCodes: [], truncated: false } })) }
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'mikka-native-evidence-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('actual early Mac failure audits without an account descriptor, scanner or database', async t => {
  const path = await directory(t)
  const content = `${JSON.stringify(observedFailure, null, 2)}\n`
  await writeFile(join(path, 'mac-acceptance-package.json'), content)
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./native-evidence.mjs', import.meta.url)), path], {
    env: { ...process.env, MIKKA_TEST_ENVIRONMENT_FILE: join(path, 'absent-account-environment.json') },
  })
  assert.equal(stderr, '')
  assert.deepEqual(JSON.parse(stdout), { status: 'audited', files: [{ name: 'mac-acceptance-package.json', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }] })
})

test('strict report schemas reject extra credential or arbitrary diagnostic fields at every nesting level', () => {
  for (const mutate of [
    report => { report.token = 'NATIVE_SCHEMA_PRIVATE_TEST_VALUE' },
    report => { report.package.identity.email = 'NATIVE_SCHEMA_PRIVATE_TEST_VALUE' },
    report => { report.launches[0].crypto.plaintext = 'NATIVE_SCHEMA_PRIVATE_TEST_VALUE' },
    report => { report.launches[0].keychainLog.stderr = 'NATIVE_SCHEMA_PRIVATE_TEST_VALUE' },
    report => { report.launches[0].keychainLog.knownStatusCodes.push(-12345) },
  ]) {
    const report = validCrypto(); mutate(report)
    assert.throws(() => validateNativeReport(report, 'crypto'), /^Error: NATIVE_EVIDENCE_SCHEMA_INVALID$/)
  }
  assert.throws(() => validateNativeReport({ ...observedFailure, failure: '/private/path/raw error' }, 'package'), /NATIVE_EVIDENCE_SCHEMA_INVALID/)
})

test('a passing report requires the actual package gates and all three prior-canary checks', () => {
  validateNativeReport(validCrypto(), 'crypto')
  for (const mutate of [
    report => { report.package.fuses.RunAsNode = true },
    report => { report.package.entitlements.executables = 0 },
    report => { report.launches[1].crypto.verifiedCanaries = 0 },
    report => { report.launches[2].crypto.decrypted = false },
    report => { delete report.launches[2].processExited },
    report => { report.sameImmutablePackage = false },
  ]) {
    const report = validCrypto(); mutate(report)
    assert.throws(() => validateNativeReport(report, 'crypto'), /NATIVE_EVIDENCE_SCHEMA_INVALID/)
  }
})

test('close failure reasons are optional closed enums, never arbitrary diagnostics or a passing result', () => {
  const report = { version: 1, passed: false, platform: 'darwin', architecture: 'arm64', revision: 'a'.repeat(40), launches: [],
    failure: { stage: 'close', code: 'NATIVE_CRYPTO_HARNESS_FAILED' }, cleanup: 'failed' }
  validateNativeReport(report, 'crypto')
  for (const closeReason of ['navigation', 'target-closed', 'installer-active', 'cancel-timeout', 'process-exit-timeout', 'process-exit-failed', 'other']) {
    validateNativeReport({ ...report, failure: { ...report.failure, closeReason } }, 'crypto')
  }
  for (const failure of [{ ...report.failure, closeReason: 'PRIVATE_VALUE /profile' }, { ...report.failure, closeReason: 'navigation', details: 'PRIVATE_VALUE' },
    { ...report.failure, stage: 'crypto', closeReason: 'navigation' }]) {
    assert.throws(() => validateNativeReport({ ...report, failure }, 'crypto'), /NATIVE_EVIDENCE_SCHEMA_INVALID/)
  }
  assert.throws(() => validateNativeReport({ ...report, passed: true, failure: { ...report.failure, closeReason: 'navigation' } }, 'crypto'), /NATIVE_EVIDENCE_SCHEMA_INVALID/)
})

test('the shared writer refuses invalid evidence before creating an output file', async t => {
  const path = join(await directory(t), 'invalid.json')
  await assert.rejects(savePackageVerification(path, { ...observedFailure, rawError: 'NATIVE_SCHEMA_PRIVATE_TEST_VALUE' }), /NATIVE_EVIDENCE_SCHEMA_INVALID/)
  await assert.rejects(access(path), { code: 'ENOENT' })
})

test('duplicate JSON keys cannot hide bytes from the audited projection', async t => {
  const path = await directory(t)
  const canonical = `${JSON.stringify(observedFailure, null, 2)}\n`
  await writeFile(join(path, 'mac-acceptance-package.json'), canonical.replace('  "version": 1,', '  "version": "NATIVE_SCHEMA_PRIVATE_TEST_VALUE",\n  "version": 1,'))
  await assert.rejects(auditNativeEvidence(path), /NATIVE_EVIDENCE_SCHEMA_INVALID/)
})

test('account JSON, logs and symlinks cannot enter the independent native report upload', async t => {
  const path = await directory(t)
  const unexpected = join(path, 'smoke.json')
  await writeFile(unexpected, JSON.stringify(observedFailure))
  await assert.rejects(auditNativeEvidence(path), /NATIVE_EVIDENCE_UNEXPECTED_FILE/)
  await rm(unexpected)
  await symlink('/outside-owned-evidence', join(path, 'native-crypto.json'))
  await assert.rejects(auditNativeEvidence(path), /NATIVE_EVIDENCE_UNEXPECTED_FILE/)
})

test('audit failure emits only a fixed error code, never untrusted fields or paths', async t => {
  const path = await directory(t)
  await writeFile(join(path, 'mac-acceptance-package.json'), `${JSON.stringify({ ...observedFailure, 'NATIVE_SCHEMA_PRIVATE_TEST_VALUE': 'raw secret' }, null, 2)}\n`)
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('./native-evidence.mjs', import.meta.url)), path]), error => {
    assert.equal(error.stdout, '')
    assert.equal(error.stderr.trim(), 'NATIVE_EVIDENCE_AUDIT_FAILED')
    return true
  })
})
