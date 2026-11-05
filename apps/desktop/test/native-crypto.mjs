import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectMacPackage, savePackageVerification } from '../scripts/verify-mac-package.mjs'
import { launchElectron } from './electron-launch.mjs'
import { closeElectron, stopLocalDaemons } from './native-cleanup.mjs'

/** Serialized into the real packaged main process by Playwright's inspector.
 * Only random, non-credential canaries are used. Plaintext, ciphertext, hashes,
 * filenames and native error text never leave main or reach the renderer. */
export async function probeCryptoInMain({ app, safeStorage }, input) {
  const report = { passed: false, phase: ['create', 'continue', 'verify'].includes(input.phase) ? input.phase : 'other', available: false, verifiedCanaries: 0, encrypted: false, decrypted: false }
  let stage = 'identity'
  try {
    const path = process.getBuiltinModule('node:path')
    const fs = process.getBuiltinModule('node:fs/promises')
    const { constants } = process.getBuiltinModule('node:fs')
    const { createHash, randomBytes } = process.getBuiltinModule('node:crypto')
    const check = value => { if (!value) throw new Error('NATIVE_CRYPTO_CHECK_FAILED') }
    await app.whenReady()
    check(app.isPackaged && app.getName() === 'Mikka Dev' && app.getPath('userData') === input.profile)
    check(path.isAbsolute(input.profile) && path.resolve(input.profile) === input.profile)
    check(path.basename(path.dirname(input.profile)).startsWith('mikka-native-crypto-'))
    check(['profile-a', 'profile-b'].includes(path.basename(input.profile)))
    check(input.canary === path.join(path.dirname(input.profile), 'canary.json'))
    check(['create', 'continue', 'verify'].includes(input.phase))
    check(!app.commandLine.hasSwitch('use-mock-keychain') && !app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.getSwitchValue('password-store'))
    report.identityMatches = true
    stage = 'availability'
    report.available = await safeStorage.isAsyncEncryptionAvailable() === true
    check(report.available)
    let canaries = []
    if (input.phase !== 'create') {
      stage = 'canary-read'
      const file = await fs.open(input.canary, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await file.stat()
        check(info.isFile() && info.size > 0 && info.size <= 8192 && (info.mode & 0o777) === 0o600)
        check(typeof process.getuid !== 'function' || info.uid === process.getuid())
        const value = JSON.parse(await file.readFile('utf8'))
        check(value.version === 1 && Array.isArray(value.canaries) && value.canaries.length === (input.phase === 'continue' ? 1 : 2))
        canaries = value.canaries
      } finally { await file.close() }
      for (const canary of canaries) {
        check(typeof canary.hash === 'string' && /^[0-9a-f]{64}$/.test(canary.hash))
        check(typeof canary.ciphertext === 'string' && canary.ciphertext.length > 0 && canary.ciphertext.length <= 4096)
        const ciphertext = Buffer.from(canary.ciphertext, 'base64')
        check(ciphertext.toString('base64') === canary.ciphertext)
        stage = 'prior-decrypt'
        const clear = await safeStorage.decryptStringAsync(ciphertext)
        check(typeof clear?.result === 'string' && createHash('sha256').update(clear.result).digest('hex') === canary.hash)
        report.verifiedCanaries += 1
      }
    }
    const plaintext = randomBytes(48).toString('hex')
    stage = 'encrypt'
    const ciphertext = await safeStorage.encryptStringAsync(plaintext)
    check(Buffer.isBuffer(ciphertext) && ciphertext.length > 0 && ciphertext.length <= 2048)
    report.encrypted = true
    stage = 'decrypt'
    const clear = await safeStorage.decryptStringAsync(ciphertext)
    check(clear?.result === plaintext)
    report.decrypted = true
    if (input.phase !== 'verify') {
      stage = 'canary-write'
      canaries.push({ hash: createHash('sha256').update(plaintext).digest('hex'), ciphertext: ciphertext.toString('base64') })
      const target = input.phase === 'create' ? input.canary : `${input.canary}.next`
      const file = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(JSON.stringify({ version: 1, canaries })); await file.sync() } finally { await file.close() }
      if (input.phase === 'continue') await fs.rename(target, input.canary)
    }
    report.passed = true
  } catch (error) {
    const codes = ['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ELOOP', 'ENOSPC', 'EIO', 'EROFS', 'NATIVE_CRYPTO_CHECK_FAILED']
    report.failure = { stage, kind: ['Error', 'TypeError', 'RangeError', 'SyntaxError'].includes(error?.name) ? error.name : 'other', code: codes.includes(error?.code) ? error.code : error?.message === 'NATIVE_CRYPTO_CHECK_FAILED' ? error.message : 'other' }
  }
  return report
}

/** Keep only a closed classification of Electron's native Keychain failure.
 * Unknown lines, paths, item names and all raw stderr are discarded. */
export function nativeKeychainLog() {
  let pending = ''
  const report = { lookupFailureCount: 0, knownStatusCodes: [], truncated: false }
  const codes = new Set()
  const consume = line => {
    if (!line.includes('Keychain lookup failed')) return
    report.lookupFailureCount = Math.min(100, report.lookupFailureCount + 1)
    for (const code of ['-25291', '-25293', '-25300', '-25308', '-67050', '-67062']) {
      if (new RegExp(`(?:^|[^0-9])${code}(?:[^0-9]|$)`).test(line)) codes.add(Number(code))
    }
  }
  return {
    push(value) {
      pending += String(value)
      if (pending.length > 16_384) { pending = pending.slice(-16_384); report.truncated = true }
      const lines = pending.split('\n'); pending = lines.pop()
      for (const line of lines) consume(line)
    },
    snapshot() { if (pending) { consume(pending); pending = '' }; return { ...report, knownStatusCodes: [...codes].sort((a, b) => a - b) } },
  }
}

async function bounded(promise, timeout, code) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), timeout) })]) } finally { clearTimeout(timer) }
}

export async function runNativeCrypto() {
  assert.equal(process.platform, 'darwin', 'NATIVE_CRYPTO_REQUIRES_MACOS')
  assert.equal(process.arch, 'arm64', 'NATIVE_CRYPTO_REQUIRES_ARM64')
  const executable = process.env.MIKKA_DESKTOP_EXECUTABLE
  assert.ok(executable, 'NATIVE_CRYPTO_EXECUTABLE_REQUIRED')
  const appPath = dirname(dirname(dirname(resolve(executable))))
  const output = resolve(process.env.MIKKA_DESKTOP_EVIDENCE ?? '.cache/desktop-evidence')
  const report = { version: 1, passed: false, platform: process.platform, architecture: process.arch, revision: /^[0-9a-f]{40}$/.test(process.env.MIKKA_TEST_DEPLOYMENT_SHA ?? '') ? process.env.MIKKA_TEST_DEPLOYMENT_SHA : null, launches: [] }
  let directory, application, failure
  const profiles = []
  const pids = new Set()
  let stage = 'package-verification'
  try {
    report.package = await inspectMacPackage(appPath, 'acceptance')
    assert.equal(report.package.passed, true, 'NATIVE_CRYPTO_PACKAGE_INVALID')
    directory = await mkdtemp(join(tmpdir(), 'mikka-native-crypto-'))
    profiles.push(join(directory, 'profile-a'), join(directory, 'profile-b'))
    await Promise.all(profiles.map(profile => mkdir(profile, { mode: 0o700 })))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].includes(key)))
    for (const [index, mode, phase] of [[0, 'bundled', 'create'], [1, 'hosted', 'continue'], [1, 'bundled', 'verify']]) {
      stage = 'launch'
      const entry = { mode, profile: index === 0 ? 'a' : 'b', phase, passed: false }
      report.launches.push(entry)
      application = await launchElectron({ executablePath: executable, args: [], cwd: fileURLToPath(new URL('../../..', import.meta.url)), env: { ...env, MIKKA_USER_DATA_DIR: profiles[index], MIKKA_DESKTOP_RENDERER: mode }, timeout: 60_000 })
      const child = application.process()
      assert.ok(child.pid && !pids.has(child.pid), 'NATIVE_CRYPTO_REUSED_PROCESS')
      pids.add(child.pid)
      const nativeLog = nativeKeychainLog()
      const consume = chunk => nativeLog.push(chunk)
      child.stderr?.on('data', consume)
      const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve([child.exitCode, child.signalCode]) : once(child, 'exit')
      let attemptFailure
      try {
        stage = 'crypto'
        entry.crypto = await bounded(application.evaluate(probeCryptoInMain, { profile: profiles[index], canary: join(directory, 'canary.json'), phase }), 30_000, 'NATIVE_CRYPTO_TIMEOUT')
        assert.equal(entry.crypto.passed, true, 'NATIVE_CRYPTO_FAILED')
        assert.equal(entry.crypto.verifiedCanaries, phase === 'create' ? 0 : phase === 'continue' ? 1 : 2, 'NATIVE_CRYPTO_PRIOR_CANARY_MISSING')
      } catch (error) { attemptFailure = error }
      try {
        await bounded(closeElectron(application), 20_000, 'NATIVE_CRYPTO_PROCESS_EXIT_TIMEOUT')
        const [exitCode, signal] = await bounded(exited, 15_000, 'NATIVE_CRYPTO_PROCESS_EXIT_TIMEOUT')
        entry.processExited = true
        application = null
        assert.ok(exitCode === 0 && signal === null, 'NATIVE_CRYPTO_PROCESS_EXIT_FAILED')
      } catch (error) {
        stage = 'close'
        attemptFailure = attemptFailure ? new AggregateError([attemptFailure, error], 'NATIVE_CRYPTO_CLOSE_FAILED') : error
      } finally {
        // Early native startup precedes Playwright returning the child handle;
        // zero here is not a claim that startup emitted no Keychain errors.
        entry.keychainLog = { observation: 'after-launch-return', ...nativeLog.snapshot() }
        child.stderr?.off('data', consume)
      }
      if (attemptFailure) throw attemptFailure
      entry.passed = true
    }
    stage = 'final-package-verification'
    const after = await inspectMacPackage(appPath, 'acceptance')
    assert.ok(after.passed && after.identity.cdHash === report.package.identity.cdHash, 'NATIVE_CRYPTO_PACKAGE_CHANGED')
    report.sameImmutablePackage = true
    report.distinctProcesses = pids.size
    report.passed = true
  } catch (error) {
    failure = error
    const codes = ['NATIVE_CRYPTO_PACKAGE_INVALID', 'NATIVE_CRYPTO_REUSED_PROCESS', 'NATIVE_CRYPTO_TIMEOUT', 'NATIVE_CRYPTO_FAILED', 'NATIVE_CRYPTO_PRIOR_CANARY_MISSING', 'NATIVE_CRYPTO_PROCESS_EXIT_TIMEOUT', 'NATIVE_CRYPTO_PROCESS_EXIT_FAILED', 'NATIVE_CRYPTO_CLOSE_FAILED', 'NATIVE_CRYPTO_PACKAGE_CHANGED']
    report.failure = { stage, code: codes.includes(error?.message) ? error.message : 'NATIVE_CRYPTO_HARNESS_FAILED' }
  } finally {
    try {
      if (application) await bounded(closeElectron(application), 20_000, 'NATIVE_CRYPTO_PROCESS_EXIT_TIMEOUT')
      await stopLocalDaemons(profiles)
      if (directory) await rm(directory, { recursive: true, force: true })
      report.cleanup = 'passed'
    } catch (error) {
      failure ??= error
      report.passed = false
      report.cleanup = 'failed'
    }
    await savePackageVerification(join(output, 'native-crypto.json'), report)
  }
  console.log(JSON.stringify(report))
  if (failure || !report.passed) throw new Error('NATIVE_CRYPTO_ACCEPTANCE_FAILED', { cause: failure })
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runNativeCrypto() } catch { console.error('NATIVE_CRYPTO_ACCEPTANCE_FAILED'); process.exitCode = 1 }
}
