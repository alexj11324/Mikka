import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { test, expect, rail, register, seedTask, openIssueFromSearch } from './fixtures'

type Box = { left: number; right: number; top: number; bottom: number }
const box = (locator: Locator) => locator.evaluate(element => {
  const rect = element.getBoundingClientRect()
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
})
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

const rootOf = (page: Page) => page.locator('header').filter({ has: page.getByRole('navigation', { name: '当前位置' }) })

async function header(page: Page) {
  const root = rootOf(page)
  const crumbs = root.getByRole('navigation', { name: '当前位置' })
  const id = crumbs.locator('[data-slot="breadcrumb-page"]')
  const actions = root.locator(':scope > div').last()
  return { root, crumbs, id, actions }
}

for (const scheme of ['light', 'dark'] as const) {
  test(`任务详情面包屑与右侧操作在各宽度不重叠，编号不截断 ${scheme}`, async ({ page }, testInfo) => {
    // 5 widths × sidebar states × screenshots outgrow the 90s default on CI runners.
    test.setTimeout(300_000)
    await page.emulateMedia({ colorScheme: scheme })
    await register(page)
    const title = `面包屑重叠检查 一个非常非常长的任务标题用来测试截断顺序 ${randomUUID().slice(0, 8)}`
    await seedTask(page, title)
    await page.reload()
    // Open the issue over 主页, where the workspace list panel sits beside it. The board is full-page
    // (no list panel), so there the toggle changes nothing on desktop and "collapsed" would be a no-op.
    await openIssueFromSearch(page, title)
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title)

    for (const width of [390, 560, 640, 768, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 800 })
      for (const sidebar of width < 768 ? ['mobile'] : ['open', 'collapsed']) {
        if (sidebar !== 'mobile') {
          // The workspace list panel reports its own state (data-slot="bot-list"); the header trigger mirrors it.
          // A missing panel fails the test instead of silently skipping the toggle.
          const panel = page.locator('[data-slot="bot-list"]')
          const toggle = rootOf(page).getByRole('button', { name: '展开或收起侧栏', exact: true })
          await expect(panel).toHaveAttribute('data-state', /^(collapsed|expanded)$/)
          const want = sidebar === 'open' ? 'expanded' : 'collapsed'
          if (await panel.getAttribute('data-state') !== want) await toggle.click()
          await expect(panel).toHaveAttribute('data-state', want)
          await expect(toggle).toHaveAttribute('aria-expanded', sidebar === 'open' ? 'true' : 'false')
          // The panel animates its width; measure and capture only once it has settled.
          await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().width)).toBe(sidebar === 'open' ? 256 : 0)
        }
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

  test(`面包屑折叠菜单：打开、键盘焦点 ${scheme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme })
    await register(page)
    const title = `面包屑菜单 ${randomUUID().slice(0, 8)}`
    await seedTask(page, title)
    await page.reload()
    await rail(page, '看板').click()
    await openIssueFromSearch(page, title)
    await page.setViewportSize({ width: 640, height: 800 })
    const more = page.getByRole('button', { name: '更多位置', exact: true })
    await expect(more).toBeVisible()
    await more.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(more).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath(`shots/fe6-menu-focus-${scheme}.png`) })
    await page.keyboard.press('Enter')
    const board = page.getByRole('menuitem', { name: '看板' })
    await expect(board).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`shots/fe6-menu-open-${scheme}.png`) })
    await page.keyboard.press('Escape')
    await expect(board).toBeHidden()
  })
}

// 动效审查 recording: the collapsed-location menu entering and leaving, then dragging the width
// across the @2xl/header breakpoint so the ellipsis and the full breadcrumb swap.
test('面包屑动效录屏：菜单进出与宽度拖动', async ({ browser }, testInfo) => {
  test.setTimeout(300_000)
  const { baseURL, extraHTTPHeaders, locale } = testInfo.project.use
  // The video is design evidence: recorded only with E2E_EVIDENCE_DIR. CI's evidence gate refuses
  // .webm files in test-results, so a normal run asserts the same steps without recording.
  const record = !!process.env.E2E_EVIDENCE_DIR
  const context = await browser.newContext({ baseURL, extraHTTPHeaders, locale, ...(record ? { recordVideo: { dir: testInfo.outputPath('video'), size: { width: 1280, height: 800 } } } : {}), viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const title = `面包屑动效 ${randomUUID().slice(0, 6)} 一个足够长的任务标题用于观察截断`
  await register(page)
  await seedTask(page, title)
  await page.reload()
  await rail(page, '看板').click()
  await openIssueFromSearch(page, title)
  await page.setViewportSize({ width: 640, height: 800 })
  const more = page.getByRole('button', { name: '更多位置', exact: true })
  for (let i = 0; i < 2; i++) {
    await more.click()
    await expect(page.getByRole('menuitem', { name: '看板' })).toBeVisible()
    await page.waitForTimeout(600)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await page.waitForTimeout(600)
  }
  for (const width of [640, 720, 800, 900, 1000, 1100, 1280, 1100, 1000, 900, 800, 720, 640, 560, 480, 390]) {
    await page.setViewportSize({ width, height: 800 })
    await page.waitForTimeout(250)
  }
  const video = record ? page.video() : null
  await context.close()
  if (video) await video.saveAs(testInfo.outputPath('shots/fe6-motion.webm'))
})
