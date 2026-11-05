import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { _electron } from '@playwright/test'

const require = createRequire(new URL('../package.json', import.meta.url))
const execFileAsync = promisify(execFile)
const preflightScript = fileURLToPath(new URL('./electron-preflight.cjs', import.meta.url))
const checkedRuntimes = new Set()

function safeDiagnostic(value) {
  return String(value).replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, '[request URL]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(token|password|code|state)=([^\s&,]+)/gi, '$1=[redacted]').slice(-6000)
}

// This credential-free process runs once, before the first measured launch.
// It makes missing libraries, display and sandbox setup visible even when
// Playwright's early inspector wait rejects without returning native stderr.
async function checkLinuxRuntime(executablePath, options) {
  if (process.platform !== 'linux' || options.executablePath) return
  assert.notEqual(process.getuid?.(), 0, 'Native acceptance requires a non-root user')
  const env = options.env ?? process.env
  const key = `${executablePath}\0${env.DISPLAY ?? ''}\0${env.DBUS_SESSION_BUS_ADDRESS ?? ''}`
  if (checkedRuntimes.has(key)) return
  const sandbox = await stat(join(dirname(executablePath), 'chrome-sandbox'))
  console.log(`Native runtime sandbox uid=${sandbox.uid} gid=${sandbox.gid} mode=${(sandbox.mode & 0o7777).toString(8)}`)
  const profile = await mkdtemp(join(tmpdir(), 'mikka-native-preflight-'))
  try {
    const { stdout } = await execFileAsync(executablePath, ['--password-store=gnome-libsecret', preflightScript], {
      cwd: options.cwd, env: { ...env, MIKKA_NATIVE_PREFLIGHT_PROFILE: profile, NODE_OPTIONS: '' },
      timeout: 30_000, maxBuffer: 64 * 1024,
    })
    assert.ok(stdout.includes('MIKKA_NATIVE_RUNTIME_READY'), 'Electron did not complete its sandboxed runtime check')
    checkedRuntimes.add(key)
  } catch (error) {
    throw new Error(`NATIVE_RUNTIME_PREFLIGHT_FAILED: ${safeDiagnostic(error.stderr || error.message)}`, { cause: error })
  } finally { await rm(profile, { recursive: true, force: true }) }
}

/** Launch the real app with its sandbox and OS keychain. An explicit binary
 * avoids Playwright's loader, which otherwise selects a mock/basic keychain.
 * Packaged acceptance uses an inspector-enabled test build; neither the
 * preflight nor that inspector setting ships in the normal build. */
export async function launchElectron(options) {
  const args = options.args ?? []
  assert.ok(!args.some(arg => /^--(?:no-sandbox|disable-setuid-sandbox)(?:=|$)/.test(arg)), 'Native acceptance requires a non-root user and the Chromium sandbox')
  const executablePath = options.executablePath ?? require('electron')
  await checkLinuxRuntime(executablePath, options)
  const setup = process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : []
  const application = await _electron.launch({ ...options, executablePath, chromiumSandbox: true, args: [...setup, ...args] })
  try {
    const flags = await application.evaluate(({ app }) => ({
      mock: app.commandLine.hasSwitch('use-mock-keychain'),
      store: app.commandLine.getSwitchValue('password-store'),
      sandboxDisabled: app.commandLine.hasSwitch('no-sandbox'),
      platform: process.platform,
    }))
    assert.equal(flags.mock, false, 'Mock keychain cannot verify encrypted session storage')
    assert.equal(flags.store, flags.platform === 'linux' ? 'gnome-libsecret' : '')
    assert.equal(flags.sandboxDisabled, false)
    return application
  } catch (error) {
    await application.close().catch(() => {})
    throw error
  }
}
