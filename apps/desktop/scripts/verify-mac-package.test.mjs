import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkEntitlements, inspectMacPackage, inspectReleaseFuses, machOFileType, packageFuses, readMachOBinaryType, signatureIdentity } from './verify-mac-package.mjs'

const appPath = '/owned/Mikka Dev.app'
const identity = `Executable=${appPath}/Contents/MacOS/Mikka Dev
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
    readBinaryType: async executable => executable.endsWith('/Mikka Dev') ? 'execute' : overrides.libraryType ?? 'dylib',
    run(executable, args, input) {
      calls.push({ executable, args, input })
      if (args[0] === '--verify') return { status: overrides.verifyStatus ?? 0, stdout: '', stderr: 'private-path SECRET' }
      if (args.includes('--verbose=4')) return { status: 0, stdout: '', stderr: (overrides.identity ?? identity).replace(`${appPath}/Contents/MacOS/Mikka Dev`, args.at(-1) === appPath ? `${appPath}/Contents/MacOS/Mikka Dev` : `${args.at(-1)}/Versions/A/Electron Framework`) }
      if (args.includes('--entitlements')) {
        // Current codesign defaults to human-readable DER, not XML. macOS 15+
        // legitimately emits nothing for the framework's MH_DYLIB signature.
        return { status: 0, stdout: args.at(-1) !== appPath && !overrides.libraryEntitlements ? '' : args.includes('--xml') ? '<plist/>' : '[Dict]\n    [Key] com.apple.security.cs.allow-jit\n    [Value]\n        [Bool] true', stderr: '' }
      }
      if (executable.endsWith('/lipo')) return { status: 0, stdout: overrides.architecture ?? 'arm64\n', stderr: '' }
      if (args.at(-1) === '-') return input?.startsWith('<plist') ? { status: 0, stdout: JSON.stringify(overrides.entitlements ?? entitlements), stderr: '' } : { status: 1, stdout: 'Unexpected character at line 1', stderr: '' }
      return { status: 0, stdout: JSON.stringify(overrides.info ?? { CFBundleIdentifier: 'com.aspectlylabs.mikka.dev', CFBundleExecutable: 'Mikka Dev', CFBundleURLTypes: [{ CFBundleURLName: 'Mikka Dev sign-in', CFBundleURLSchemes: ['mikka-dev-auth'] }] }), stderr: '' }
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
  assert.ok(fixture.calls.filter(call => call.args.includes('--entitlements')).every(call => call.args.includes('--xml') && !call.args.includes(':-')))
  assert.deepEqual(report.entitlements, { hardenedRuntime: true, devOnlyLibraryValidationException: true, unexpected: false, executables: 1, libraries: 1, librariesWithoutEntitlements: 1 })
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
    [{ info: { CFBundleIdentifier: 'com.aspectlylabs.mikka.dev', CFBundleExecutable: 'Mikka Dev' } }, 'MAC_PACKAGE_URL_SCHEME'],
    [{ info: { CFBundleIdentifier: 'com.aspectlylabs.mikka.dev', CFBundleExecutable: 'Mikka Dev', CFBundleURLTypes: [{ CFBundleURLSchemes: ['mikka-auth', 'mikka-dev-auth'] }] } }, 'MAC_PACKAGE_URL_SCHEME'],
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

test('empty entitlement is permitted only for a real DYLIB, never a renamed executable', async () => {
  assert.equal(checkEntitlements({}, 'dylib'), 'absent-library')
  assert.throws(() => checkEntitlements({}, 'execute'), /MAC_PACKAGE_ENTITLEMENTS/)
  assert.throws(() => checkEntitlements({ 'com.apple.security.get-task-allow': true }, 'dylib'), /MAC_PACKAGE_ENTITLEMENTS/)
  const report = await inspectMacPackage(appPath, 'acceptance', runtime({ libraryType: 'execute' }))
  assert.equal(report.passed, false)
  assert.equal(report.failure, 'MAC_PACKAGE_ENTITLEMENTS')
})

function header(type, little = true) {
  const result = Buffer.alloc(32)
  const uint32 = (value, offset) => little ? result.writeUInt32LE(value, offset) : result.writeUInt32BE(value, offset)
  uint32(0xfeedfacf, 0); uint32(0x0100000c, 4); uint32(type, 12)
  return result
}

test('Mach-O classification reads actual ARM64 filetype and rejects unknown or truncated headers', () => {
  for (const little of [true, false]) {
    assert.equal(machOFileType(header(2, little)), 'execute')
    assert.equal(machOFileType(header(6, little)), 'dylib')
  }
  assert.throws(() => machOFileType(header(8)), /MAC_PACKAGE_MACHO_TYPE/)
  assert.throws(() => machOFileType(Buffer.alloc(12)), /MAC_PACKAGE_MACHO_TYPE/)
  const intel = header(6); intel.writeUInt32LE(0x01000007, 4)
  assert.throws(() => machOFileType(intel), /MAC_PACKAGE_MACHO_TYPE/)
})

test('actual file reads follow only sealed in-app binaries and bound FAT offsets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-macho-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'Mikka Dev.app')
  await mkdir(app)
  const binary = join(app, 'executable-name-does-not-decide-type')
  await writeFile(binary, header(6))
  assert.equal(await readMachOBinaryType(binary, app), 'dylib')
  const fat = Buffer.alloc(96)
  fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(1, 4)
  fat.writeUInt32BE(0x0100000c, 8); fat.writeUInt32BE(64, 16); fat.writeUInt32BE(32, 20)
  header(2).copy(fat, 64)
  await writeFile(binary, fat)
  assert.equal(await readMachOBinaryType(binary, app), 'execute')
  fat.writeUInt32BE(4096, 16)
  await writeFile(binary, fat)
  await assert.rejects(readMachOBinaryType(binary, app), /MAC_PACKAGE_MACHO_TYPE/)
  const outside = join(root, 'outside')
  await writeFile(outside, header(6))
  const link = join(app, 'linked')
  await symlink(outside, link)
  await assert.rejects(readMachOBinaryType(link, app), /MAC_PACKAGE_MACHO_TYPE/)
})

test('signed production release reads its own package and requires the production fuse policy', async () => {
  const releasePath = '/owned/release/mac-arm64/Mikka.app'
  const calls = []
  const fuses = await inspectReleaseFuses(releasePath, {
    readFuses: async path => { calls.push(path); return { ...wire, 3: 48 } },
  })
  assert.deepEqual(calls, [releasePath])
  assert.equal(fuses.RunAsNode, false)
  assert.equal(fuses.EnableNodeOptionsEnvironmentVariable, false)
  assert.equal(fuses.EnableNodeCliInspectArguments, false)
  assert.equal(fuses.OnlyLoadAppFromAsar, true)
})

test('release fuse verification rejects the inspector or incomplete wire and preserves read failures', async () => {
  for (const unsafe of [wire, { ...wire, 3: 48, 5: undefined }]) {
    await assert.rejects(inspectReleaseFuses('/owned/Mikka.app', { readFuses: async () => unsafe }), /MAC_PACKAGE_FUSES/)
  }
  const failure = new Error('FIXTURE_FUSE_READ_FAILED')
  await assert.rejects(inspectReleaseFuses('/owned/Mikka.app', { readFuses: async () => { throw failure } }), error => error === failure)
  let calls = 0
  for (const invalid of ['relative/Mikka.app', '/owned/Mikka Dev.app']) {
    await assert.rejects(inspectReleaseFuses(invalid, { readFuses: async () => { calls++; return { ...wire, 3: 48 } } }), /MAC_PACKAGE_ARGUMENTS/)
  }
  assert.equal(calls, 0)
})

test('release verification uses the installed fuse SDK to read an actual fixture file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-release-fuses-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'Mikka.app')
  const framework = join(app, 'Contents', 'Frameworks', 'Electron Framework.framework')
  await mkdir(framework, { recursive: true })
  const executable = join(framework, 'Electron Framework')
  // A fuse-wire fixture, not a signed Mach-O application. The production path
  // uses this same SDK reader after the normal signature/notarization hook.
  const prefix = Buffer.from('fixture:dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
  const states = [48, 49, 48, 48, 48, 49, 48, 49]
  const bytes = () => Buffer.concat([prefix, Buffer.from([1, states.length, ...states])])
  await writeFile(executable, bytes())
  assert.equal((await inspectReleaseFuses(app)).EnableNodeCliInspectArguments, false)
  states[3] = 49
  await writeFile(executable, bytes())
  await assert.rejects(inspectReleaseFuses(app), /MAC_PACKAGE_FUSES/)
})
