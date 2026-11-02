import type { Page } from '@playwright/test'
import { test, expect, register } from './fixtures'

// The macOS desktop window (docs/design/platforms.md): under data-desktop-translucent
// the window bar, the rail and the bot list let the window's material through a
// grey veil (--shell-material); the content column stays opaque. A browser has no
// vibrancy, so a solid color on <html>, behind the page, stands in for the material.
const MATERIAL = [255, 0, 170] as const

type Point = { x: number; y: number }
type Pixel = [number, number, number]

async function pixels(page: Page, points: Point[]): Promise<Pixel[]> {
  const png = (await page.screenshot()).toString('base64')
  return page.evaluate(async ({ png, points }) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob())
    const context = new OffscreenCanvas(image.width, image.height).getContext('2d')!
    context.drawImage(image, 0, 0)
    const scale = image.width / window.innerWidth
    return points.map(({ x, y }) => Array.from(context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)) as [number, number, number])
  }, { png, points })
}

const near = (pixel: Pixel, expected: readonly number[], tolerance = 3) => pixel.every((value, index) => Math.abs(value - expected[index]) <= tolerance)

async function translucent(page: Page, on: boolean, background: string) {
  await page.evaluate(({ on, background }) => {
    const root = document.documentElement
    root.dataset.desktopPlatform = 'darwin'
    if (on) root.dataset.desktopTranslucent = ''
    else delete root.dataset.desktopTranslucent
    root.style.background = background
  }, { on, background })
  // Two frames, so the attribute's styles are painted before the screenshot.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function regions(page: Page) {
  const bar = (await page.locator('[data-slot="window-bar"]').boundingBox())!
  const rail = (await page.getByRole('navigation', { name: '主导航', exact: true }).boundingBox())!
  const list = page.locator('[data-slot="bot-list"]')
  const listBox = (await list.boundingBox())!
  const current = (await list.locator('[data-active]').first().boundingBox())!
  const content = (await page.locator('main[data-slot="sidebar-inset"]').boundingBox())!
  return {
    bar: { x: bar.x + bar.width * 0.25, y: bar.y + bar.height / 2 },
    rail: { x: rail.x + rail.width / 2, y: rail.y + rail.height * 0.6 },
    list: { x: listBox.x + listBox.width / 2, y: listBox.y + listBox.height - 24 },
    current: { x: current.x + current.width / 2, y: current.y + 3 },
    content: { x: content.x + content.width / 2, y: content.y + content.height - 24 },
  }
}

test('macOS translucent window: chrome shows the material, content stays opaque', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await register(page)
  await expect(page.locator('[data-slot="bot-list"]')).toBeVisible()
  await expect(page.locator('[data-slot="bot-list"] [data-active]').first()).toBeVisible()
  const at = await regions(page)

  // Reduce transparency, Windows and Linux: no attribute, the opaque frame.
  await translucent(page, false, `rgb(${MATERIAL.join(',')})`)
  const opaque = await pixels(page, [at.bar, at.rail, at.list])
  for (const pixel of opaque) expect(near(pixel, MATERIAL, 40), `opaque ${pixel}`).toBe(false)

  await translucent(page, true, `rgb(${MATERIAL.join(',')})`)
  const [bar, rail, list, current, content] = await pixels(page, [at.bar, at.rail, at.list, at.current, at.content])
  // The chrome is veiled (--shell-material): the material shows only faintly, neither raw nor the opaque frame.
  for (const [name, pixel, solid] of [['window bar', bar, opaque[0]], ['rail', rail, opaque[1]], ['bot list', list, opaque[2]]] as const) {
    expect(near(pixel, MATERIAL, 40), `${name} ${pixel} is veiled`).toBe(false)
    expect(near(pixel, solid, 3), `${name} ${pixel} still shows the material`).toBe(false)
    expect(pixel[0] - pixel[1] > 8, `${name} ${pixel} keeps a trace of the material`).toBe(true)
  }
  // The current row is an overlay on the veil: it reads apart from the list.
  expect(near(current, list, 6), `current row ${current} vs list ${list}`).toBe(false)
  expect(near(content, [255, 255, 255]), `content ${content}`).toBe(true)

  // Evidence for review: the same window over a gradient, light and dark.
  await translucent(page, true, 'linear-gradient(135deg, #ff3d7f, #ffb03b 45%, #2fd4c4)')
  await testInfo.attach('translucent-light', { body: await page.screenshot(), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  await translucent(page, true, 'linear-gradient(135deg, #ff3d7f, #ffb03b 45%, #2fd4c4)')
  await testInfo.attach('translucent-dark', { body: await page.screenshot(), contentType: 'image/png' })
})
