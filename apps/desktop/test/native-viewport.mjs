import assert from 'node:assert/strict'

/** Keep the actual Electron renderer at a fixed CSS layout size even when a
 * hosted macOS runner has a smaller virtual display. Playwright sends Chromium
 * device metrics, not a page zoom or image resize. The physical native window
 * may remain constrained; record it separately rather than misreporting it. */
export async function setNativeViewport(application, page, viewport) {
  assert.ok(Number.isSafeInteger(viewport.width) && viewport.width > 0 && Number.isSafeInteger(viewport.height) && viewport.height > 0)
  await application.evaluate(({ BrowserWindow }, bounds) => {
    const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
    if (!window) throw new Error('NATIVE_VIEWPORT_WINDOW_REQUIRED')
    window.setContentSize(bounds.width, bounds.height)
    window.webContents.setZoomFactor(1)
  }, viewport)
  // This also fixes deviceScaleFactor to 1 in Playwright's Electron context.
  // Do not supply a CDP scale, CSS zoom, image resize or reduced screenshot.
  await page.setViewportSize(viewport)
  await page.waitForLoadState('domcontentloaded')
  const layout = await assertNativeViewport(page, viewport)
  const native = await application.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
    if (!window) throw new Error('NATIVE_VIEWPORT_WINDOW_REQUIRED')
    const [width, height] = window.getContentSize()
    const display = screen.getDisplayMatching(window.getBounds())
    return {
      content: { width, height },
      display: { width: display.size.width, height: display.size.height, scaleFactor: display.scaleFactor },
      zoomFactor: window.webContents.getZoomFactor(),
    }
  })
  assert.equal(native.zoomFactor, 1)
  return { method: 'playwright_cdp_layout_viewport', requested: { ...viewport }, layout, native }
}

export async function assertNativeViewport(page, viewport) {
  const actual = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio,
    visualWidth: visualViewport?.width, visualHeight: visualViewport?.height, visualScale: visualViewport?.scale,
  }))
  // A native document scrollbar can legitimately reduce visualWidth/Height.
  // Layout dimensions and raw bitmap stay fixed; visual scale must stay 1.
  const { width, height, deviceScaleFactor, visualScale } = actual
  assert.deepEqual({ width, height, deviceScaleFactor, visualScale }, {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1,
    visualScale: 1,
  }, 'Native renderer must use the full requested layout at one device pixel per CSS pixel')
  return actual
}

/** Read the original PNG IHDR. No decoding/resampling can hide a size error. */
export function assertViewportPng(bytes, viewport) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 33, 'Screenshot must be a complete PNG header')
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(bytes.readUInt32BE(8), 13)
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR')
  const actual = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  assert.deepEqual(actual, viewport, 'Original screenshot bitmap must match the requested viewport without resizing')
  return actual
}
