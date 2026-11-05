import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { _electron } from '@playwright/test'

const keychainBootstrap = fileURLToPath(new URL('./electron-keychain.cjs', import.meta.url))

/** Launch the real app with its sandbox and OS keychain. The source-only
 * bootstrap changes Playwright's automation flags, never application behavior.
 * With executablePath, Playwright does not inject its loader and no bootstrap
 * is needed. Packaged acceptance uses an inspector-enabled test build; neither
 * this bootstrap nor the inspector setting ships in the normal build. */
export async function launchElectron(options) {
  const args = options.args ?? []
  assert.ok(!args.some(arg => /^--(?:no-sandbox|disable-setuid-sandbox)(?:=|$)/.test(arg)), 'Native acceptance requires a non-root user and the Chromium sandbox')
  const setup = options.executablePath
    ? (process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : [])
    : ['--require', keychainBootstrap]
  const application = await _electron.launch({ ...options, chromiumSandbox: true, args: [...setup, ...args] })
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
