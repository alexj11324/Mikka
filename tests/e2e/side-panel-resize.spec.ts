import type { Locator, Page } from '@playwright/test'
import { test, expect, register, registerInTeam, app } from './fixtures'

async function drag(page: Page, handle: Locator, dx: number) {
  const box = await handle.boundingBox()
  if (!box) throw new Error('resize handle has no box')
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 4 })
  await page.mouse.move(x + dx, y, { steps: 4 })
  await page.mouse.up()
}

async function widthOf(locator: Locator) {
  return Math.round((await locator.boundingBox())?.width ?? 0)
}

// The bot list and the right panel resize from their inner edges, as in Codex and Linear.
test('Both side columns resize from their inner edge and keep the width after reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await register(page)

  const list = page.locator('[data-slot="bot-list"]')
  const panel = page.getByRole('complementary', { name: '右栏', exact: true })
  const listEdge = page.getByRole('separator', { name: '调整 Bot 列表宽度' })
  const panelEdge = page.getByRole('separator', { name: '调整右栏宽度' })
  await expect(list).toHaveAttribute('data-state', 'expanded')
  await expect(panel).toBeVisible()
  await expect(listEdge).toHaveAttribute('aria-valuenow', '256')
  await expect(panelEdge).toHaveAttribute('aria-valuenow', '360')
  // The panel's limit is half the window, measured once the page is interactive.
  await expect(panelEdge).toHaveAttribute('aria-valuemax', '720')

  // Dragging the list's right edge to the right widens it; the panel's left edge to the left widens it.
  await drag(page, listEdge, 80)
  await expect(listEdge).toHaveAttribute('aria-valuenow', '336')
  await expect.poll(() => widthOf(list)).toBe(336)
  await expect(list).toHaveAttribute('data-state', 'expanded')
  await drag(page, panelEdge, -120)
  await expect(panelEdge).toHaveAttribute('aria-valuenow', '480')
  await expect.poll(() => widthOf(panel)).toBe(480)

  // The widths stop at their limits: 400px for the list, half the window for the panel.
  await drag(page, listEdge, 300)
  await expect(listEdge).toHaveAttribute('aria-valuenow', '400')
  await drag(page, listEdge, -64)
  await expect(listEdge).toHaveAttribute('aria-valuenow', '336')
  await drag(page, panelEdge, -600)
  await expect(panelEdge).toHaveAttribute('aria-valuenow', '720')
  await drag(page, panelEdge, 240)
  await expect(panelEdge).toHaveAttribute('aria-valuenow', '480')

  await page.reload()
  await expect(panelEdge).toHaveAttribute('aria-valuemax', '720')
  await expect(list).toHaveAttribute('data-state', 'expanded')
  await expect(listEdge).toHaveAttribute('aria-valuenow', '336')
  await expect(panelEdge).toHaveAttribute('aria-valuenow', '480')
  await expect.poll(() => widthOf(list)).toBe(336)
  await expect.poll(() => widthOf(panel)).toBe(480)

  // Arrow keys on the edge resize too, and the width is remembered.
  await panelEdge.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(panelEdge).toHaveAttribute('aria-valuenow', '496')
  await listEdge.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(listEdge).toHaveAttribute('aria-valuenow', '320')
  await page.reload()
  await expect(panelEdge).toHaveAttribute('aria-valuemax', '720')
  await expect(panelEdge).toHaveAttribute('aria-valuenow', '496')
  await expect(listEdge).toHaveAttribute('aria-valuenow', '320')

  // A double-click resets the default width and does not fold the list.
  await listEdge.dblclick()
  await panelEdge.dblclick()
  await expect(listEdge).toHaveAttribute('aria-valuenow', '256')
  await expect(panelEdge).toHaveAttribute('aria-valuenow', '360')
  await page.waitForTimeout(500)
  await expect(list).toHaveAttribute('data-state', 'expanded')
  await expect.poll(() => widthOf(panel)).toBe(360)
  await page.reload()
  await expect(panelEdge).toHaveAttribute('aria-valuemax', '720')
  await expect(listEdge).toHaveAttribute('aria-valuenow', '256')
  await expect(panelEdge).toHaveAttribute('aria-valuenow', '360')

  // 加宽 still widens the panel and puts the old width back.
  await page.getByRole('button', { name: '加宽右栏', exact: true }).click()
  await expect(panelEdge).toHaveAttribute('aria-valuenow', '520')
  await page.getByRole('button', { name: '恢复右栏宽度', exact: true }).click()
  await expect(panelEdge).toHaveAttribute('aria-valuenow', '360')

  // A single click still folds the list.
  await listEdge.click()
  await expect(list).toHaveAttribute('data-state', 'collapsed')
})

/** Waits until the handle stops moving: a reset width springs back to its default. */
async function settled(handle: Locator) {
  let last = ''
  await expect.poll(async () => { const box = JSON.stringify(await handle.boundingBox()); const same = box === last; last = box; return same }, { intervals: [100] }).toBe(true)
}

/** Every vertical line on the page that runs most of its height: an element's own side border, as a column draws it. */
async function verticalDividers(page: Page) {
  return page.evaluate(() => {
    const lines: { x: number; name: string }[] = []
    for (const element of document.querySelectorAll<HTMLElement>('main *, [data-slot="bot-list"], [data-slot="settings-list"], aside')) {
      const box = element.getBoundingClientRect()
      if (!box.width || box.height < window.innerHeight * 0.4 || box.right <= 0 || box.left >= window.innerWidth) continue
      const style = getComputedStyle(element)
      if (style.visibility === 'hidden' || element.closest('[aria-hidden="true"], [inert]')) continue
      const name = `${element.tagName.toLowerCase()}${element.dataset.slot ? `[${element.dataset.slot}]` : ''}${element.getAttribute('aria-label') ? ` "${element.getAttribute('aria-label')}"` : ''}`
      // A column draws one side; a card or a field with both sides is not a divider.
      const left = parseFloat(style.borderLeftWidth) >= 1, right = parseFloat(style.borderRightWidth) >= 1
      if (left && !right && box.left > 1) lines.push({ x: box.left, name })
      if (right && !left && box.right < window.innerWidth - 1) lines.push({ x: box.right, name })
    }
    return lines
  })
}

// Decision 2026-11-01-1310 (R-80): every vertical line between columns resizes them, at Alex's 1000px window too.
test('Every vertical divider on every rail page drags to resize, with a col-resize cursor', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 })
  await registerInTeam(page)
  const pages: [string, string][] = [
    ['chat', app('/')],
    ['suggestions', app('/?section=suggestions')],
    ['board', app('/?section=all-issues')],
    ['plugins', app('/?section=plugins')],
    ['artifacts', app('/?section=artifacts')],
    ['settings', app('/settings?section=general')],
  ]
  for (const width of [1000, 1440]) {
    await page.setViewportSize({ width, height: 720 })
    for (const [name, url] of pages) {
      await page.goto(url)
      await page.waitForLoadState('networkidle')
      const handles = page.locator('[data-slot="resize-handle"]:visible')
      const boxes = await Promise.all((await handles.all()).map(handle => handle.boundingBox()))
      for (const line of await verticalDividers(page)) {
        expect(boxes.some(box => box && Math.abs(box.x + box.width / 2 - line.x) <= 8), `${width}px ${name}: the line of ${line.name} at x=${Math.round(line.x)} has no resize handle`).toBe(true)
      }
      for (const handle of await handles.all()) {
        const label = await handle.getAttribute('aria-label')
        await settled(handle)
        await handle.hover()
        expect(await handle.evaluate(element => getComputedStyle(element).cursor), `${width}px ${name}: ${label}`).toBe('col-resize')
        const before = await handle.getAttribute('aria-valuenow')
        let dx = 48
        await drag(page, handle, dx)
        let after = await handle.getAttribute('aria-valuenow')
        // At its limit one way, it moves the other way.
        if (after === before) { dx = -48; await drag(page, handle, dx * 2); after = await handle.getAttribute('aria-valuenow') }
        expect(after, `${width}px ${name}: dragging ${label} changes nothing`).not.toBe(before)
        // A double-click goes back to the default, and the line still drags right after it (the selection it leaves must not cancel the drag).
        await handle.dblclick()
        const reset = await handle.getAttribute('aria-valuenow')
        expect(reset, `${width}px ${name}: double-clicking ${label}`).toBe(before)
        await settled(handle)
        await drag(page, handle, dx)
        expect(await handle.getAttribute('aria-valuenow'), `${width}px ${name}: ${label} after a double-click`).not.toBe(reset)
        await handle.dblclick()
      }
    }
  }
})
