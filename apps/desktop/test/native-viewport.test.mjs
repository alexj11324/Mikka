import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { launchElectron } from './electron-launch.mjs'
import { assertNativeViewport, assertViewportPng, setNativeViewport } from './native-viewport.mjs'

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
