import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { launchElectron } from './electron-launch.mjs'
import { assertNativeViewport, assertViewportPng, setNativeViewport } from './native-viewport.mjs'
import { selectWorkspaceMenuItem } from './native-document.mjs'

const require = createRequire(import.meta.url)
const sharp = createRequire(require.resolve('next/package.json'))('sharp')
const viewport = { width: 1440, height: 900 }

test('real Electron keeps exact layout, edge interaction and unscaled pixels when the native window is smaller', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'mikka-viewport-'))
  let application
  try {
    application = await launchElectron({ args: [fileURLToPath(new URL('./fixtures/native-viewport.cjs', import.meta.url))], env: { ...process.env, MIKKA_VIEWPORT_PROFILE: profile }, timeout: 30_000 })
    const page = await application.firstWindow()
    await page.waitForLoadState('load')
    const evidence = await setNativeViewport(application, page, viewport)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 600))
    assert.deepEqual(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize()), [800, 600])
    await assertNativeViewport(page, viewport)
    await page.getByRole('button', { name: 'Edge click' }).click()
    assert.equal(await page.title(), 'clicked')
    await page.reload()
    await assertNativeViewport(page, viewport)
    const bytes = await page.screenshot({ type: 'png', scale: 'device' })
    assertViewportPng(bytes, viewport)
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const pixel = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)]
    assert.deepEqual(pixel(1439, 899), [255, 0, 0, 255], 'One CSS pixel remains exactly one screenshot pixel at the far edge')
    assert.deepEqual(pixel(1438, 899), [0, 0, 255, 255])
    assert.deepEqual(pixel(1437, 899), [255, 255, 255, 255])
    console.log(JSON.stringify({ ...evidence, constrainedNativeContent: { width: 800, height: 600 }, png: { width: info.width, height: info.height }, edgePixelsAndInteraction: true }))
  } finally { await application?.close(); await rm(profile, { recursive: true, force: true }) }
})

test('real Electron waits for a same-URL workspace document before reading the renderer', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'mikka-workspace-document-'))
  let application
  try {
    application = await launchElectron({ args: [fileURLToPath(new URL('./fixtures/native-viewport.cjs', import.meta.url))], env: { ...process.env, MIKKA_VIEWPORT_PROFILE: profile }, timeout: 30_000 })
    const page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    await page.waitForLoadState('load')
    await setNativeViewport(application, page, viewport)
    const before = await page.evaluate(() => performance.timeOrigin)
    let selected = false
    const selection = selectWorkspaceMenuItem(page, page.getByRole('menuitem', { name: 'Switch workspace' })).then(() => { selected = true })
    // Observe the click while withholding completion of the asynchronous
    // switch. The URL and all old DOM controls remain visible, as in the app.
    await page.waitForFunction(() => document.documentElement.dataset.switchRequested === 'true')
    await page.waitForURL(page.url(), { waitUntil: 'domcontentloaded' })
    assert.equal(selected, false, 'the old same-URL wait must not satisfy the new document gate')
    const oldRead = page.evaluate(() => new Promise(() => { globalThis.__workspaceReadPending = true })).then(
      () => false, error => /Execution context was destroyed|Cannot find context with specified id/.test(error.message))
    await page.waitForFunction(() => globalThis.__workspaceReadPending === true)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload())
    await selection
    assert.equal(await oldRead, true, 'a read issued in the old document loses its context on the real reload')
    assert.notEqual(await page.evaluate(() => performance.timeOrigin), before)
    await assertNativeViewport(page, viewport)
    await page.locator('#workspace').evaluate(item => item.setAttribute('aria-current', 'true'))
    const current = await page.evaluate(() => performance.timeOrigin)
    await selectWorkspaceMenuItem(page, page.getByRole('menuitem', { name: 'Switch workspace' }))
    assert.equal(await page.evaluate(() => performance.timeOrigin), current, 'an already-current choice does not require another document')
  } finally { await application?.close(); await rm(profile, { recursive: true, force: true }) }
})
