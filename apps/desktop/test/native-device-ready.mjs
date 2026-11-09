import assert from 'node:assert/strict'
import { isAbsolute, resolve } from 'node:path'
import { readNativeDaemonMetadata } from './native-metadata.mjs'

/** Runs in the renderer. Identifiers, installer output and exception messages
 * stay there; the harness receives only this closed readiness projection. */
export async function nativeDeviceSnapshot() {
  const bridge = window.mikka
  const select = (value, values) => values.includes(value) ? value : 'other'
  const reason = value => {
    if (typeof value !== 'string' || !value) return 'none'
    if (value === 'cancelled') return 'cancelled'
    if (value === 'Device did not come online within 30 seconds') return 'online-timeout'
    if (value === 'Device account could not be confirmed') return 'owner-unconfirmed'
    if (value === 'Device does not belong to the signed-in account') return 'owner-mismatch'
    if (value === 'Sign in to register a device') return 'registration-denied'
    if (value === 'SSH operation timed out') return 'command-timeout'
    if (/Node\.js >=[0-9]+ required/.test(value)) return 'node-required'
    if (/(?:command not found|mikka: not found)/.test(value)) return 'command-missing'
    if (/\b(?:EACCES|EPERM)\b|Permission denied/.test(value)) return 'permission-denied'
    if (/\bENOTEMPTY\b/.test(value)) return 'npm-directory-not-empty'
    if (/\bE404\b/.test(value)) return 'npm-package-not-found'
    if (/\b(?:ENOTFOUND|EAI_AGAIN)\b/.test(value)) return 'dns-failed'
    if (/\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/.test(value)) return 'network-failed'
    if (/Bootstrap failed:/.test(value)) return 'service-bootstrap-failed'
    if (/Failed to connect to (?:user scope )?bus/.test(value)) return 'service-manager-unavailable'
    return 'other'
  }
  const bootstrapErrorCode = value => {
    if (typeof value !== 'string' || !value.includes('Bootstrap failed:')) return null
    const match = /(?:^|\n)Bootstrap failed: (0|[1-9][0-9]{0,2}):/.exec(value)
    const code = match ? Number(match[1]) : -1
    return code >= 0 && code <= 255 ? code : 'other'
  }
  const present = { device: typeof bridge?.device?.status === 'function', installer: typeof bridge?.ssh?.state === 'function' }
  const results = await Promise.allSettled([
    present.device ? bridge.device.status() : Promise.resolve(null),
    present.installer ? bridge.ssh.state() : Promise.resolve(null),
  ])
  const device = results[0].status === 'fulfilled' ? results[0].value : null
  const install = results[1].status === 'fulfilled' ? results[1].value : null
  return {
    bridge: present,
    device: { read: results[0].status, status: select(device?.status, ['offline', 'connecting', 'online']),
      deviceIdPresent: typeof device?.deviceId === 'string' && device.deviceId.length > 0,
      signedIn: device?.signedIn === true, server: select(device?.server, [null, 'offline', 'connecting', 'online', 'unregistered']) },
    installer: { read: results[1].status, present: Boolean(install && typeof install === 'object'),
      status: install === null ? 'absent' : select(install?.status, ['fingerprint', 'running', 'online', 'failed']),
      step: install === null ? 'absent' : select(install?.step, ['login', 'check', 'install', 'service', 'connect']),
      target: install === null ? 'absent' : select(install?.target, ['this-computer', 'this-computer-reconnect']),
      reason: reason(install?.reason), bootstrapErrorCode: bootstrapErrorCode(install?.reason), retryable: install?.retryable === true },
  }
}

export function nativeDeviceIsReady(state) {
  return state?.bridge?.device === true && state.bridge.installer === true
    && state.device.read === 'fulfilled' && state.device.status === 'online'
    && state.device.deviceIdPresent === true && state.device.signedIn === true && state.device.server === 'online'
    && state.installer.read === 'fulfilled' && ['absent', 'online'].includes(state.installer.status)
}

/** Main inspector reads only this run's profile and the fixed per-user service
 * definition. It neither executes the CLI nor returns paths, IDs or file data. */
export async function nativeDeviceEnvironment(application, profile) {
  return application.evaluate(async ({ app }, expected) => {
    const path = process.getBuiltinModule('node:path')
    const fs = process.getBuiltinModule('node:fs/promises')
    const os = process.getBuiltinModule('node:os')
    if (!path.isAbsolute(expected) || path.resolve(expected) !== expected || app.getPath('userData') !== expected) return { available: false, reason: 'profile-mismatch' }
    const kind = async filename => {
      try {
        const item = await fs.lstat(filename)
        return item.isFile() ? 'file' : item.isDirectory() ? 'directory' : item.isSocket() ? 'socket' : item.isSymbolicLink() ? 'symlink' : 'other'
      } catch (error) { return error?.code === 'ENOENT' ? 'absent' : 'unreadable' }
    }
    const files = {}
    for (const name of ['daemon.sock', 'daemon.secret', 'daemon.pid', 'daemon.lock', 'device.json']) files[name] = await kind(path.join(expected, name))
    const service = { platform: ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : 'other', definition: 'unsupported', profile: 'unknown', dev: false, installedVersion: null, installedRevision: null }
    if (process.platform === 'darwin') {
      const filename = path.join(os.homedir(), 'Library/LaunchAgents/com.aspectlylabs.mikka.daemon.plist')
      service.definition = await kind(filename)
      if (service.definition === 'file') {
        try {
          const info = await fs.lstat(filename)
          if (info.size > 131072) throw new Error('bounded-service-file')
          const value = await fs.readFile(filename, 'utf8')
          const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(value)?.[1]
          if (array && !array.replace(/<string>[\s\S]*?<\/string>/g, '').trim()) {
            const args = [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => match[1].replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'))
            const indices = args.flatMap((arg, index) => arg === '--data-dir' ? [index] : [])
            service.profile = indices.length === 1 ? args[indices[0] + 1] === expected ? 'matches' : 'different' : indices.length ? 'ambiguous' : 'absent'
            service.dev = args.includes('--dev')
            if (service.profile === 'matches' && typeof args[1] === 'string' && path.isAbsolute(args[1])) {
              try {
                const entry = await fs.realpath(args[1])
                const manifestPath = path.join(path.dirname(entry), 'package.json')
                const manifestInfo = await fs.lstat(manifestPath)
                if (manifestInfo.isFile() && manifestInfo.size <= 65536) {
                  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
                  if (manifest.name === '@aspectlylabs/mikka') {
                    if (typeof manifest.version === 'string' && manifest.version.length <= 100 && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) service.installedVersion = manifest.version
                    if (typeof manifest.gitHead === 'string' && /^[a-f0-9]{40}$/.test(manifest.gitHead)) service.installedRevision = manifest.gitHead
                  }
                }
              } catch { /* The unavailable identity remains explicit, never inferred from this checkout. */ }
            }
          }
        } catch { service.profile = 'unreadable' }
      }
    }
    return { available: true, profileMatches: true, overrideMatches: process.env.MIKKA_USER_DATA_DIR === expected, files, service }
  }, profile)
}

async function bounded(promise, ms) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('NATIVE_DEVICE_READ_TIMEOUT')), ms) })]) }
  finally { clearTimeout(timer) }
}

/** The gate remains the actual preload's local daemon + authenticated server
 * state. Polling is test-only; no setup, retry, enrollment or response is faked. */
// Product setup already permits a 300s npm installation. Retain the original
// 180s allowance for the remaining setup instead of cancelling a valid install
// before its own product deadline. Failed installers do not use this allowance.
export async function waitForNativeDevice(target, { scope, profile, record, timeout = 480_000,
  snapshot = () => target.page.evaluate(nativeDeviceSnapshot), metadata = () => readNativeDaemonMetadata(profile),
  environment = () => nativeDeviceEnvironment(target.application, profile), now = Date.now,
  delay = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  assert.ok(typeof profile === 'string' && isAbsolute(profile) && resolve(profile) === profile, 'NATIVE_DEVICE_EXACT_PROFILE_REQUIRED')
  assert.ok(Number.isFinite(timeout) && timeout > 0 && timeout <= 480_000, 'NATIVE_DEVICE_WAIT_BOUND_REQUIRED')
  const started = now()
  const evidence = { mode: ['bundled', 'hosted'].includes(target.mode) ? target.mode : 'other', ready: false, deadlineMs: timeout, elapsedMs: 0, reads: 0, navigationInterruptions: 0, transitions: [], overflow: false, failure: null }
  record?.(evidence)
  let previous
  try {
    while (now() - started < timeout) {
      await scope.assertActive()
      const remaining = timeout - (now() - started)
      if (remaining <= 0) break
      let state
      try { state = await bounded(snapshot(), Math.min(5000, remaining)) }
      catch (error) {
        // A real reload may destroy this read's document. Retry only that
        // exact interruption on an open page, within the original deadline.
        if (!(error instanceof Error) || error.name !== 'Error'
          || error.message !== 'page.evaluate: Execution context was destroyed, most likely because of a navigation'
          || error.code !== undefined || error.cause !== undefined || target.page?.isClosed?.() !== false) throw error
        evidence.navigationInterruptions++
        await delay(Math.min(250, Math.max(0, timeout - (now() - started))))
        continue
      }
      evidence.reads++
      const key = JSON.stringify(state)
      if (key !== previous) {
        if (evidence.transitions.length < 32) evidence.transitions.push({ elapsedMs: now() - started, ...state })
        else evidence.overflow = true
        previous = key
      }
      if (state.installer?.status === 'failed') {
        evidence.failure = 'installer-failed'
        throw new Error('PARITY_NATIVE_DEVICE_NOT_READY')
      }
      if (nativeDeviceIsReady(state)) { evidence.ready = true; return evidence }
      await delay(Math.min(250, Math.max(0, timeout - (now() - started))))
    }
    evidence.failure = 'deadline'
    throw new Error('PARITY_NATIVE_DEVICE_NOT_READY')
  } finally {
    evidence.elapsedMs = now() - started
    evidence.daemon = await bounded(metadata(), 5000).catch(() => ({ status: 'unavailable', reason: 'metadata-failed' }))
    evidence.environment = await bounded(environment(), 5000).catch(() => ({ available: false, reason: 'environment-failed' }))
  }
}
