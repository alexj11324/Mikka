import { spawnSync } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../package.json', import.meta.url))
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
const { getCurrentFuseWire, FuseV1Options } = appBuilderRequire('@electron/fuses')
const fuseRequire = createRequire(appBuilderRequire.resolve('@electron/fuses'))
const { FuseState } = fuseRequire('./constants')

const DEV_ID = 'com.aspectlylabs.mikka.dev'
const ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.disable-library-validation',
].sort()
const FAILURE_CODES = new Set([
  'MAC_PACKAGE_ARGUMENTS', 'MAC_PACKAGE_PLATFORM', 'MAC_PACKAGE_SIGNATURE',
  'MAC_PACKAGE_IDENTITY', 'MAC_PACKAGE_HARDENED_RUNTIME', 'MAC_PACKAGE_ENTITLEMENTS',
  'MAC_PACKAGE_INFO', 'MAC_PACKAGE_ARCHITECTURE', 'MAC_PACKAGE_FUSES',
  'MAC_PACKAGE_NESTED_SIGNATURE', 'MAC_PACKAGE_COMMAND_FAILED',
])
function need(value, code) { if (!value) throw new Error(code) }

function command(executable, args, input) {
  const result = spawnSync(executable, args, { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 })
  if (result.error) throw new Error('MAC_PACKAGE_COMMAND_FAILED', { cause: result.error })
  return result
}
function output(run, executable, args, code, input) {
  const result = run(executable, args, input)
  need(result.status === 0, code)
  return result.stdout
}
function field(text, name) {
  const values = text.split('\n').filter(line => line.startsWith(`${name}=`))
  need(values.length === 1, 'MAC_PACKAGE_IDENTITY')
  return values[0].slice(name.length + 1).trim()
}

/** Parse only fixed identity fields; never retain codesign's executable paths
 * or arbitrary stderr in evidence. A valid signature alone is insufficient. */
export function signatureIdentity(text, expectedId) {
  const identifier = field(text, 'Identifier')
  const signature = field(text, 'Signature')
  const team = field(text, 'TeamIdentifier')
  const hash = field(text, 'CDHash')
  const flags = [...text.matchAll(/^CodeDirectory .*?\bflags=0x([0-9a-f]+)\b/gmi)]
  need(!expectedId || identifier === expectedId, 'MAC_PACKAGE_IDENTITY')
  need(signature === 'adhoc' && team === 'not set' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash), 'MAC_PACKAGE_IDENTITY')
  need(flags.length === 1 && (Number.parseInt(flags[0][1], 16) & 0x10002) === 0x10002, 'MAC_PACKAGE_HARDENED_RUNTIME')
  return { adHoc: true, teamIdentifier: 'none', hardenedRuntime: true, cdHash: hash }
}

export function packageFuses(wire, variant) {
  need(['dev', 'acceptance'].includes(variant) && wire?.version === '1', 'MAC_PACKAGE_FUSES')
  const result = {}
  for (const [name, index] of Object.entries(FuseV1Options)) {
    if (typeof index !== 'number') continue
    const state = wire[index]
    result[name] = state === FuseState.ENABLE ? true : state === FuseState.DISABLE ? false : null
  }
  for (const [name, enabled] of Object.entries({
    RunAsNode: false,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: variant === 'acceptance',
    OnlyLoadAppFromAsar: true,
  })) need(result[name] === enabled, 'MAC_PACKAGE_FUSES')
  return result
}

async function codeBundles(appPath) {
  const bundles = [appPath]
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.name.endsWith('.app') || entry.name.endsWith('.framework')) bundles.push(path)
      await visit(path)
    }
  }
  await visit(join(appPath, 'Contents', 'Frameworks'))
  need(bundles.includes(join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework')), 'MAC_PACKAGE_NESTED_SIGNATURE')
  return bundles
}

/** Read the final package only. This never signs, changes a fuse, launches an
 * executable, inspects a Keychain item, or imports release credentials. */
export async function inspectMacPackage(appPath, variant, {
  run = command, readFuses = getCurrentFuseWire, listBundles = codeBundles, platform = process.platform,
} = {}) {
  const report = { version: 1, variant: ['dev', 'acceptance'].includes(variant) ? variant : 'other', passed: false }
  try {
    need(platform === 'darwin', 'MAC_PACKAGE_PLATFORM')
    need(['dev', 'acceptance'].includes(variant) && isAbsolute(appPath) && basename(appPath) === 'Mikka Dev.app', 'MAC_PACKAGE_ARGUMENTS')
    output(run, '/usr/bin/codesign', ['--verify', '--strict', '--deep', appPath], 'MAC_PACKAGE_SIGNATURE')
    report.signatureVerifiedStrictDeep = true
    const info = JSON.parse(output(run, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Contents', 'Info.plist')], 'MAC_PACKAGE_INFO'))
    need(info.CFBundleIdentifier === DEV_ID && info.CFBundleExecutable === 'Mikka Dev', 'MAC_PACKAGE_INFO')
    report.bundleIdentifier = DEV_ID
    const arch = output(run, '/usr/bin/lipo', ['-archs', join(appPath, 'Contents', 'MacOS', 'Mikka Dev')], 'MAC_PACKAGE_ARCHITECTURE').trim()
    need(arch === 'arm64', 'MAC_PACKAGE_ARCHITECTURE')
    report.architecture = arch
    const bundles = await listBundles(appPath)
    need(bundles.length >= 2 && bundles[0] === appPath, 'MAC_PACKAGE_NESTED_SIGNATURE')
    for (const path of bundles) {
      const result = run('/usr/bin/codesign', ['--display', '--verbose=4', path])
      need(result.status === 0, 'MAC_PACKAGE_IDENTITY')
      const identity = signatureIdentity(result.stderr, path === appPath ? DEV_ID : undefined)
      if (path === appPath) report.identity = identity
      const plist = output(run, '/usr/bin/codesign', ['--display', '--entitlements', ':-', path], 'MAC_PACKAGE_ENTITLEMENTS')
      const entitlements = JSON.parse(output(run, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], 'MAC_PACKAGE_ENTITLEMENTS', plist))
      need(JSON.stringify(Object.keys(entitlements).sort()) === JSON.stringify(ENTITLEMENTS) && ENTITLEMENTS.every(key => entitlements[key] === true), 'MAC_PACKAGE_ENTITLEMENTS')
    }
    report.signedBundleCount = bundles.length
    report.entitlements = { hardenedRuntime: true, devOnlyLibraryValidationException: true, unexpected: false }
    report.fuses = packageFuses(await readFuses(appPath), variant)
    report.passed = true
  } catch (error) {
    report.failure = FAILURE_CODES.has(error?.message) ? error.message : 'MAC_PACKAGE_VERIFICATION_FAILED'
  }
  return report
}

export async function savePackageVerification(path, report) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [variant, appPath, reportPath, extra] = process.argv.slice(2)
  if (!appPath || !reportPath || extra) throw new Error('MAC_PACKAGE_ARGUMENTS')
  const report = await inspectMacPackage(resolve(appPath), variant)
  await savePackageVerification(resolve(reportPath), report)
  console.log(JSON.stringify(report))
  if (!report.passed) process.exitCode = 1
}
