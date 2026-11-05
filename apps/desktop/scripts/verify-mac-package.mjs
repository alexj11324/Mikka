import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateNativeReport } from './native-evidence.mjs'

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
  'MAC_PACKAGE_ENTITLEMENTS_FORMAT', 'MAC_PACKAGE_MACHO_TYPE',
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

/** ARM64 Mach-O filetype, not a filename convention. Entitlements grant rights
 * to MH_EXECUTE processes; macOS 15+ normally omits them from MH_DYLIB files. */
export function machOFileType(header) {
  need(Buffer.isBuffer(header) && header.length >= 32, 'MAC_PACKAGE_MACHO_TYPE')
  const little = header.readUInt32LE(0) === 0xfeedfacf
  need(little || header.readUInt32BE(0) === 0xfeedfacf, 'MAC_PACKAGE_MACHO_TYPE')
  const uint32 = offset => little ? header.readUInt32LE(offset) : header.readUInt32BE(offset)
  need(uint32(4) === 0x0100000c, 'MAC_PACKAGE_MACHO_TYPE')
  const type = uint32(12)
  need(type === 2 || type === 6, 'MAC_PACKAGE_MACHO_TYPE')
  return type === 2 ? 'execute' : 'dylib'
}

export async function readMachOBinaryType(executable, appPath) {
  const [root, path] = await Promise.all([realpath(appPath), realpath(executable)])
  const within = relative(root, path)
  need(within && within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within), 'MAC_PACKAGE_MACHO_TYPE')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    need(info.isFile() && info.size >= 32, 'MAC_PACKAGE_MACHO_TYPE')
    const read = async (offset, size) => {
      need(Number.isSafeInteger(offset) && offset >= 0 && offset + size <= info.size, 'MAC_PACKAGE_MACHO_TYPE')
      const buffer = Buffer.alloc(size)
      need((await file.read(buffer, 0, size, offset)).bytesRead === size, 'MAC_PACKAGE_MACHO_TYPE')
      return buffer
    }
    const header = await read(0, 32)
    const magic = header.readUInt32BE(0)
    if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) return machOFileType(header)
    const little = magic === 0xbebafeca || magic === 0xbfbafeca
    const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca
    const uint32 = (buffer, offset) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
    const count = uint32(header, 4)
    need(count > 0 && count <= 32, 'MAC_PACKAGE_MACHO_TYPE')
    const size = fat64 ? 32 : 20
    const table = await read(8, count * size)
    const slices = []
    for (let index = 0; index < count; index++) {
      const start = index * size
      if (uint32(table, start) !== 0x0100000c) continue
      const offset = fat64 ? Number(little ? table.readBigUInt64LE(start + 8) : table.readBigUInt64BE(start + 8)) : uint32(table, start + 8)
      const length = fat64 ? Number(little ? table.readBigUInt64LE(start + 16) : table.readBigUInt64BE(start + 16)) : uint32(table, start + 12)
      need(Number.isSafeInteger(length) && length >= 32 && offset >= 8 + table.length && offset + length <= info.size, 'MAC_PACKAGE_MACHO_TYPE')
      slices.push(offset)
    }
    need(slices.length === 1, 'MAC_PACKAGE_MACHO_TYPE')
    return machOFileType(await read(slices[0], 32))
  } finally { await file.close() }
}

export function checkEntitlements(value, fileType) {
  need(['execute', 'dylib'].includes(fileType) && value && typeof value === 'object' && !Array.isArray(value), 'MAC_PACKAGE_ENTITLEMENTS')
  const keys = Object.keys(value).sort()
  if (fileType === 'dylib' && keys.length === 0) return 'absent-library'
  need(JSON.stringify(keys) === JSON.stringify(ENTITLEMENTS) && ENTITLEMENTS.every(key => value[key] === true), 'MAC_PACKAGE_ENTITLEMENTS')
  return 'exact'
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
  run = command, readFuses = getCurrentFuseWire, listBundles = codeBundles, readBinaryType = readMachOBinaryType, platform = process.platform,
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
    const types = { executables: 0, libraries: 0, librariesWithoutEntitlements: 0 }
    for (const path of bundles) {
      const result = run('/usr/bin/codesign', ['--display', '--verbose=4', path])
      need(result.status === 0, 'MAC_PACKAGE_IDENTITY')
      const identity = signatureIdentity(result.stderr, path === appPath ? DEV_ID : undefined)
      if (path === appPath) report.identity = identity
      const fileType = await readBinaryType(field(result.stderr, 'Executable'), appPath)
      if (path.endsWith('.app')) need(fileType === 'execute', 'MAC_PACKAGE_MACHO_TYPE')
      // TN3125: the default display is human-readable DER, not a plist. Request
      // XML explicitly; an unsigned/empty main executable still fails below.
      const plist = output(run, '/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', path], 'MAC_PACKAGE_ENTITLEMENTS')
      const entitlements = plist.trim() ? JSON.parse(output(run, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], 'MAC_PACKAGE_ENTITLEMENTS_FORMAT', plist)) : {}
      const checked = checkEntitlements(entitlements, fileType)
      if (fileType === 'execute') types.executables += 1
      else types.libraries += 1
      if (checked === 'absent-library') types.librariesWithoutEntitlements += 1
    }
    report.signedBundleCount = bundles.length
    report.entitlements = { hardenedRuntime: true, devOnlyLibraryValidationException: true, unexpected: false, ...types }
    report.fuses = packageFuses(await readFuses(appPath), variant)
    report.passed = true
  } catch (error) {
    report.failure = FAILURE_CODES.has(error?.message) ? error.message : 'MAC_PACKAGE_VERIFICATION_FAILED'
  }
  return report
}

export async function savePackageVerification(path, report) {
  validateNativeReport(report, Object.hasOwn(report, 'variant') ? 'package' : 'crypto')
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
