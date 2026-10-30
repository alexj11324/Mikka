import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { test, expect, rail, register, seedTask, openIssueFromSearch } from './fixtures'

type Box = { left: number; right: number; top: number; bottom: number }
const box = (locator: Locator) => locator.evaluate(element => {
  const rect = element.getBoundingClientRect()
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
})
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

async function header(page: Page) {
  const root = page.locator('header').filter({ has: page.getByRole('navigation', { name: '当前位置' }) })
  const crumbs = root.getByRole('navigation', { name: '当前位置' })
  const id = crumbs.locator('[data-slot="breadcrumb-page"]')
  const actions = root.locator(':scope > div').last()
  return { root, crumbs, id, actions }
}

for (const scheme of ['light', 'dark'] as const) {
  test(`任务详情面包屑与右侧操作在各宽度不重叠，编号不截断 ${scheme}`, async ({ page }, testInfo) => {
    // 5 widths × sidebar states × screenshots outgrow the 90s default on CI runners.
    test.setTimeout(240_000)
    await page.emulateMedia({ colorScheme: scheme })
    await register(page)
    const title = `面包屑重叠检查 一个非常非常长的任务标题用来测试截断顺序 ${randomUUID().slice(0, 8)}`
    await seedTask(page, title)
    await page.reload()
    await rail(page, '看板').click()
    await openIssueFromSearch(page, title)
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title)

    for (const width of [390, 768, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 800 })
      for (const sidebar of width < 768 ? ['mobile'] : ['open', 'collapsed']) {
        const toggle = page.getByRole('button', { name: '展开或收起侧栏', exact: true }).first()
        const expanded = await page.locator('[data-slot="sidebar"][data-state]').first().getAttribute('data-state').catch(() => null)
        if (sidebar === 'open' && expanded === 'collapsed') await toggle.click()
        if (sidebar === 'collapsed' && expanded === 'expanded') await toggle.click()
        const { root, crumbs, id, actions } = await header(page)
        await expect(id).toBeVisible()
        await expect.poll(async () => {
          const [c, a] = await Promise.all([box(crumbs), box(actions)])
          return overlaps(c, a) || c.right > a.left
        }, { message: `breadcrumb overlaps actions at ${width} (${sidebar})` }).toBe(false)
        // The identifier never truncates: its full width is visible inside the clipped breadcrumb.
        await expect.poll(async () => id.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
        const [i, c] = await Promise.all([box(id), box(root.locator(':scope > div').first())])
        // EBFC-1 sits fully inside the left container, so overflow-hidden never clips it (incl. 390px mobile).
        expect(i.left).toBeGreaterThanOrEqual(c.left - 0.5)
        expect(i.right).toBeLessThanOrEqual(c.right + 0.5)
        expect(i.right - i.left).toBeGreaterThan(0)
        await expect(id).toHaveText(/^[A-Z]+-\d+$/)
        // One line: nothing wraps below the 48px bar.
        expect((await box(crumbs)).bottom - (await box(crumbs)).top).toBeLessThanOrEqual(32)
        await page.screenshot({ path: testInfo.outputPath(`shots/fe6-${width}-${sidebar}-${scheme}.png`) })
      }
    }
  })
}
