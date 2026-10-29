// Local Electron acceptance: launches the shell against a running web app and
// asserts the bridge, the renderer's isolation, the daemon-backed calls and,
// when a daemon is registered, the desktop-only "本机" identity.
//
//   MIKKA_DESKTOP_APP_URL=http://localhost:3000/mikka \
//   MIKKA_DESKTOP_FLAVOR=dev pnpm --filter @mikka/desktop build
//   xvfb-run -a node apps/desktop/test/smoke.mjs
//
// Set MIKKA_SMOKE_EXPECT_LOCAL=1 when a signed-in daemon runs with the same
// MIKKA_USER_DATA_DIR. Exit code 0 means every assertion passed.

import { rmSync } from 'node:fs'
import { _electron as electron } from '@playwright/test'

const appUrl = process.env.MIKKA_SMOKE_APP_URL ?? 'http://localhost:3000/mikka'
const userData = process.env.MIKKA_USER_DATA_DIR ?? '/tmp/mikka-desktop-smoke'
const screenshot = process.env.MIKKA_SMOKE_SCREENSHOT ?? '/tmp/mikka-desktop-smoke.png'
const expectLocal = process.env.MIKKA_SMOKE_EXPECT_LOCAL === '1'
const appOrigin = new URL(appUrl).origin

// A dedicated profile keeps a stale lock from an interrupted run out of the
// developer's real Mikka Dev data directory.
for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) rmSync(`${userData}/${name}`, { force: true })

const fail = message => { throw new Error(message) }

const application = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`],
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, MIKKA_USER_DATA_DIR: userData },
  timeout: 90_000,
})

try {
  const page = await application.firstWindow({ timeout: 90_000 })
  page.setDefaultTimeout(120_000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  await page.waitForLoadState('domcontentloaded', { timeout: 90_000 })
  async function navigate(url) {
    for (let attempt = 1; ; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 })
        return
      } catch (error) {
        if (attempt === 3 || !String(error).includes('ERR_ABORTED')) throw error
        await new Promise(resolve => setTimeout(resolve, 1_000))
      }
    }
  }
  console.log('window', page.url())
  if (!page.url().startsWith(appOrigin)) fail(`window left the app origin: ${page.url()}`)

  const info = await page.evaluate(() => ({
    runtime: window.mikka?.app?.runtime,
    version: window.mikka?.app?.version,
    flavor: window.mikka?.app?.flavor,
    serverUrl: window.mikka?.app?.serverUrl,
    requireType: typeof window.require,
    processType: typeof window.process,
    hasAuth: typeof window.mikka?.auth,
    hasSettings: typeof window.mikka?.settings,
    hasDeviceStatus: typeof window.mikka?.device?.status,
    hasQuota: typeof window.mikka?.quota?.get,
    hasNotifications: typeof window.mikka?.notifications?.show,
    hasBadge: typeof window.mikka?.notifications?.setBadge,
  }))
  console.log('bridge', JSON.stringify(info))
  if (info.runtime !== 'electron') fail('window.mikka.app.runtime is not electron')
  if (info.requireType !== 'undefined') fail('window.require is exposed')
  if (info.processType !== 'undefined') fail('window.process is exposed')
  if (info.hasDeviceStatus !== 'function') fail('device.status is missing')
  if (info.hasQuota !== 'function') fail('quota.get is missing')
  if (info.hasNotifications !== 'function') fail('notifications.show is missing')
  if (info.hasBadge !== 'function') fail('notifications.setBadge is missing')
  if (info.hasAuth !== 'undefined') fail('the v1 bridge must not expose auth')

  // Main validates notification payloads even though only our renderer can
  // call them; badge changes and a malformed notification exercise both paths.
  const notifications = await page.evaluate(async () => {
    await window.mikka.notifications.setBadge(3)
    await window.mikka.notifications.setBadge(0)
    let rejected = false
    try {
      await window.mikka.notifications.show({ id: '', kind: 'awaiting', title: '', body: '', href: 'https://evil.example' })
    } catch { rejected = true }
    return { rejected }
  })
  if (!notifications.rejected) fail('notifications.show accepted an invalid payload')

  // Sign in through the development-only endpoint from a stable page. The
  // sign-in page with login=1 does not auto-redirect in development, so the
  // fetch cannot race a client-side navigation.
  await navigate(`${appOrigin}/mikka/en/sign-in?login=1`)
  await page.evaluate(async () => {
    const response = await fetch('/mikka/api/test-workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (!response.ok) throw new Error(`test session ${response.status}`)
  })
  // A fresh profile has no prior app cookie, so enter the signed-in app.
  await navigate(`${appOrigin}/mikka/en`)

  const device = await page.evaluate(() => window.mikka.device.status())
  console.log('device', JSON.stringify(device))
  if (!device || !['online', 'offline', 'connecting'].includes(device.status)) fail('device.status returned an invalid state')

  const quota = await page.evaluate(() => window.mikka.quota.get())
  console.log('quota', JSON.stringify(quota).slice(0, 200))
  if (!quota || !Array.isArray(quota.quotas)) fail('quota.get returned no report')

  // The retired standalone page redirects to the one Settings surface.
  await navigate(`${appOrigin}/mikka/devices`)
  await page.waitForURL(url => url.pathname.endsWith('/settings') && url.searchParams.get('section') === 'devices', { timeout: 180_000 })
  console.log('legacy /devices redirected to', page.url())
  await page.waitForFunction(() => /设备|Devices/.test(document.body.innerText), { timeout: 180_000 })
  const settingsText = await page.locator('body').innerText()

  if (expectLocal) {
    if (device.status !== 'online') fail(`expected the local daemon online, got ${device.status}`)
    if (!device.deviceId) fail('device.status returned no deviceId')
    if (!/本机|This machine/.test(settingsText)) fail('settings devices page lost 本机')
    console.log('settings devices page shows 本机')
  } else {
    console.log('settings devices page rendered')
  }
  await page.screenshot({ path: screenshot })
  if (pageErrors.length > 0) fail(`renderer errors: ${pageErrors.join(' | ')}`)

  console.log('screenshot', screenshot)
  console.log('SMOKE OK')
} finally {
  await application.close()
}
