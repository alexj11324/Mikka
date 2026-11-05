import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectMacPackage, packageFuses, signatureIdentity } from './verify-mac-package.mjs'

const appPath = '/owned/Mikka Dev.app'
const identity = `Executable=/private/path/not-for-evidence
Identifier=com.aspectlylabs.mikka.dev
CodeDirectory v=20500 size=100 flags=0x10002(adhoc,runtime) hashes=1+1 location=embedded
CDHash=${'ab'.repeat(20)}
Signature=adhoc
TeamIdentifier=not set
`
const entitlements = Object.fromEntries(['allow-jit', 'allow-unsigned-executable-memory', 'allow-dyld-environment-variables', 'disable-library-validation'].map(name => [`com.apple.security.cs.${name}`, true]))
const wire = { version: '1', 0: 48, 1: 49, 2: 48, 3: 49, 4: 48, 5: 49, 6: 48, 7: 49 }

function runtime(overrides = {}) {
  const calls = []
  return {
    calls,
    platform: 'darwin',
    readFuses: async () => overrides.wire ?? wire,
    listBundles: async () => [appPath, `${appPath}/Contents/Frameworks/Electron Framework.framework`],
    run(executable, args, input) {
      calls.push({ executable, args, input })
      if (args[0] === '--verify') return { status: overrides.verifyStatus ?? 0, stdout: '', stderr: 'private-path SECRET' }
      if (args.includes('--verbose=4')) return { status: 0, stdout: '', stderr: overrides.identity ?? identity }
      if (args.includes('--entitlements')) return { status: 0, stdout: '<plist/>', stderr: '' }
      if (executable.endsWith('/lipo')) return { status: 0, stdout: overrides.architecture ?? 'arm64\n', stderr: '' }
      if (args.at(-1) === '-') return { status: 0, stdout: JSON.stringify(overrides.entitlements ?? entitlements), stderr: '' }
      return { status: 0, stdout: JSON.stringify(overrides.info ?? { CFBundleIdentifier: 'com.aspectlylabs.mikka.dev', CFBundleExecutable: 'Mikka Dev' }), stderr: '' }
    },
  }
}

test('final package verification checks deep strict signatures, nested identities and actual fuses', async () => {
  const fixture = runtime()
  const report = await inspectMacPackage(appPath, 'acceptance', fixture)
  assert.equal(report.passed, true)
  assert.equal(report.signedBundleCount, 2)
  assert.equal(report.fuses.EnableNodeCliInspectArguments, true)
  assert.deepEqual(fixture.calls[0].args, ['--verify', '--strict', '--deep', appPath])
  assert.equal(fixture.calls.filter(call => call.args.includes('--entitlements')).length, 2)
  assert.equal(JSON.stringify(report).includes('/private/'), false)
})

test('failed signature verification cannot be replaced with plausible identity metadata', async () => {
  const fixture = runtime({ verifyStatus: 1 })
  const report = await inspectMacPackage(appPath, 'acceptance', fixture)
  assert.equal(report.passed, false)
  assert.equal(report.failure, 'MAC_PACKAGE_SIGNATURE')
  assert.equal(fixture.calls.length, 1)
  assert.equal(JSON.stringify(report).includes('SECRET'), false)
})

test('signed but wrong identity, architecture, hardened runtime or entitlements fails closed', async () => {
  for (const [overrides, code] of [
    [{ identity: identity.replace('Signature=adhoc', 'Authority=Developer ID Application: Other') }, 'MAC_PACKAGE_IDENTITY'],
    [{ identity: identity.replace('TeamIdentifier=not set', 'TeamIdentifier=OTHERTEAM') }, 'MAC_PACKAGE_IDENTITY'],
    [{ identity: identity.replace('flags=0x10002', 'flags=0x2') }, 'MAC_PACKAGE_HARDENED_RUNTIME'],
    [{ architecture: 'x86_64 arm64' }, 'MAC_PACKAGE_ARCHITECTURE'],
    [{ entitlements: { ...entitlements, 'com.apple.security.get-task-allow': true } }, 'MAC_PACKAGE_ENTITLEMENTS'],
    [{ entitlements: { ...entitlements, 'com.apple.security.cs.disable-library-validation': false } }, 'MAC_PACKAGE_ENTITLEMENTS'],
  ]) {
    const report = await inspectMacPackage(appPath, 'acceptance', runtime(overrides))
    assert.equal(report.passed, false)
    assert.equal(report.failure, code)
  }
})

test('downloadable Dev inspector fuse must be off, and removed or missing security fuses reject', () => {
  assert.throws(() => packageFuses(wire, 'dev'), /MAC_PACKAGE_FUSES/)
  assert.equal(packageFuses({ ...wire, 3: 48 }, 'dev').EnableNodeCliInspectArguments, false)
  for (const key of [0, 2, 3, 5]) {
    for (const state of [undefined, 114, 144, wire[key] === 48 ? 49 : 48]) {
      assert.throws(() => packageFuses({ ...wire, [key]: state }, 'acceptance'), /MAC_PACKAGE_FUSES/)
    }
  }
  assert.throws(() => packageFuses({ ...wire, version: '2' }, 'acceptance'), /MAC_PACKAGE_FUSES/)
})

test('identity parsing rejects duplicate fields instead of guessing which signature to trust', () => {
  assert.throws(() => signatureIdentity(`${identity}TeamIdentifier=not set\n`), /MAC_PACKAGE_IDENTITY/)
  assert.throws(() => signatureIdentity(identity.replace('com.aspectlylabs.mikka.dev', 'com.aspectlylabs.mikka'), 'com.aspectlylabs.mikka.dev'), /MAC_PACKAGE_IDENTITY/)
})
