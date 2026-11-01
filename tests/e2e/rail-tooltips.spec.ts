import type { Page, TestInfo } from '@playwright/test'
import { test, expect, register } from './fixtures'

// R-35 (decision 2026-11-01-1240): rail items are icons only; each name is a
// tooltip on hover and the button's accessible name. #747 brought labels back once.
const NAMES = ['主页', '建议', '看板', '插件', 'Artifact'] as const

async function shoot(page: Page, testInfo: TestInfo, name: string) {
  const box = (await page.getByRole('navigation', { name: '主导航', exact: true }).boundingBox())!
  await testInfo.attach(name, { body: await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width + 120, height: 300 } }), contentType: 'image/png' })
}

test('左侧导航只显示图标，名字在 hover 时以提示出现', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await register(page)
  const rail = page.getByRole('navigation', { name: '主导航', exact: true })
  const tooltip = page.locator('[data-slot="tooltip-content"]')
  await expect(rail.getByRole('button', { name: '主页', exact: true })).toBeVisible()
  expect(Math.round((await rail.boundingBox())!.width)).toBe(68)

  for (const name of NAMES) {
    const item = rail.getByRole('button', { name, exact: true })
    await expect(item).toBeVisible()
    // No visible text inside the button: the name lives in aria-label only.
    expect((await item.innerText()).trim()).toBe('')
  }
  await expect(rail.getByText('主页', { exact: true })).toHaveCount(0)
  await expect(tooltip).toHaveCount(0)

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await page.mouse.move(800, 450)
    await expect(tooltip).toHaveCount(0)
    await shoot(page, testInfo, `rail-default-${scheme}`)
    await rail.getByRole('button', { name: '看板', exact: true }).hover()
    await expect(tooltip).toHaveText('看板')
    await shoot(page, testInfo, `rail-hover-${scheme}`)
  }
})
