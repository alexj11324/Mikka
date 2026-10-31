import type { Locator, Page } from '@playwright/test'
import { test, expect, register } from './fixtures'

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
