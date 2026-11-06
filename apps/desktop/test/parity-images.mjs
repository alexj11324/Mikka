import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'

// Next already pins sharp; acceptance does not add a second native PNG stack.
const require = createRequire(import.meta.url)
const sharp = createRequire(require.resolve('next/package.json'))('sharp')
const DYNAMIC = ['[data-slot="bot-avatar"]', '[data-slot="avatar"]', 'time']

/** Only documented changing avatars and timestamps are masked. Keep their
 * rectangles as evidence and require the geometry to match between builds. */
export async function screenshot(page, path, { identities = [] } = {}) {
  await page.bringToFront()
  await page.mouse.move(0, 0)
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="skeleton"], [aria-busy="true"]')].every(element => {
    const box = element.getBoundingClientRect()
    return !box.width || !box.height || getComputedStyle(element).visibility === 'hidden'
  }), undefined, { timeout: 45_000 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const masks = await page.locator(DYNAMIC.join(',')).evaluateAll(elements => elements.flatMap(element => {
    const box = element.getBoundingClientRect()
    if (!box.width || !box.height || box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight || getComputedStyle(element).visibility === 'hidden') return []
    return [{ kind: element.tagName === 'TIME' ? 'time' : 'avatar', x: box.x, y: box.y, width: box.width, height: box.height }]
  }).sort((a, b) => a.y - b.y || a.x - b.x || a.width - b.width))
  const identityMasks = identities.map(value => page.getByText(value, { exact: true }))
  for (const locator of identityMasks) masks.push(...await locator.evaluateAll(elements => elements.flatMap(element => {
    const box = element.getBoundingClientRect()
    if (!box.width || !box.height || box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight || getComputedStyle(element).visibility === 'hidden') return []
    return [{ kind: 'identity', x: box.x, y: box.y, width: box.width, height: box.height }]
  })))
  const bytes = await page.screenshot({ path, animations: 'disabled', caret: 'hide', mask: [...DYNAMIC.map(selector => page.locator(`${selector}:visible`)), ...identityMasks], maskColor: '#808080', scale: 'css' })
  return { bytes, masks }
}

export async function compareImages(before, after, differencePath, { maximumRatio = 0.001 } = {}) {
  const [a, b] = await Promise.all([sharp(before.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), sharp(after.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })])
  assert.deepEqual({ width: a.info.width, height: a.info.height, channels: a.info.channels }, { width: b.info.width, height: b.info.height, channels: b.info.channels }, 'Screenshot dimensions must match')
  const pixels = a.info.width * a.info.height
  const diff = Buffer.alloc(pixels * 4)
  let changed = 0
  const identityRectangles = [...before.masks, ...after.masks].filter(mask => mask.kind === 'identity')
  let excludedIdentityPixels = 0
  for (let pixel = 0; pixel < pixels; pixel++) {
    const offset = pixel * 4
    const x = pixel % a.info.width; const y = Math.floor(pixel / a.info.width)
    // Independent before/after leases have different generated email text.
    // Exclude only the union of those exact text rectangles, never a row/card.
    const identity = identityRectangles.some(box => x >= Math.floor(box.x) && x < Math.ceil(box.x + box.width) && y >= Math.floor(box.y) && y < Math.ceil(box.y + box.height))
    if (identity) excludedIdentityPixels++
    // Exact pixel comparison: no hidden colour threshold or antialias allowance.
    const different = !identity && (a.data[offset] !== b.data[offset] || a.data[offset + 1] !== b.data[offset + 1] || a.data[offset + 2] !== b.data[offset + 2] || a.data[offset + 3] !== b.data[offset + 3])
    if (different) {
      changed++
      diff[offset] = 255; diff[offset + 1] = 0; diff[offset + 2] = 70
    } else {
      const gray = Math.round((a.data[offset] + a.data[offset + 1] + a.data[offset + 2]) / 3)
      diff[offset] = diff[offset + 1] = diff[offset + 2] = Math.round(220 + gray * 35 / 255)
    }
    diff[offset + 3] = 255
  }
  await sharp(diff, { raw: { width: a.info.width, height: a.info.height, channels: 4 } }).png().toFile(differencePath)
  const geometryMatches = JSON.stringify(before.masks.filter(mask => mask.kind !== 'identity')) === JSON.stringify(after.masks.filter(mask => mask.kind !== 'identity'))
  const comparedPixels = pixels - excludedIdentityPixels
  return { width: a.info.width, height: a.info.height, changedPixels: changed, totalPixels: pixels, comparedPixels, excludedIdentityPixels, changedRatio: changed / comparedPixels, maximumRatio, masks: before.masks, maskGeometryMatches: geometryMatches, passed: geometryMatches && changed / comparedPixels <= maximumRatio }
}

export async function writeImageReport(path, report) {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
}
