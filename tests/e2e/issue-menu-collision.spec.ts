import { randomUUID } from 'node:crypto'
import type { Locator } from '@playwright/test'
import { test, expect, rail, register, seedTask, openIssueFromSearch } from './fixtures'

async function expectInsideViewport(locator: Locator, width: number, height: number) {
  await expect.poll(async () => locator.evaluate((element, viewport) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
      && rect.right <= viewport.width && rect.bottom <= viewport.height
  }, { width, height }), { message: 'menu item must remain inside the viewport' }).toBe(true)
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 1280, height: 900 }, { width: 1280, height: 480 }]) {
  test(`任务操作菜单使用组件默认碰撞限高，首尾与状态子菜单可访问 ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await register(page)
    const title = `菜单碰撞 ${randomUUID().slice(0, 8)}`
    await seedTask(page, title)
    await page.reload()
    await rail(page, '看板').click()
    await openIssueFromSearch(page, title)
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title)
    await page.setViewportSize(viewport)

    const trigger = page.getByRole('button', { name: '更多任务操作', exact: true })
    await expect(trigger).toBeEnabled()
    await trigger.click()
    const menu = page.locator('[data-slot="dropdown-menu-content"]')
    const status = page.getByRole('menuitem', { name: '设置状态', exact: true })
    await expect(status).toBeVisible()
    // toBeVisible alone accepts clipped content; assert the actual viewport bounds too.
    await expectInsideViewport(menu, viewport.width, viewport.height)
    await expectInsideViewport(status, viewport.width, viewport.height)
    await status.hover()
    const submenu = page.locator('[data-slot="dropdown-menu-sub-content"]')
    await expect(submenu).toBeVisible()
    await expectInsideViewport(submenu, viewport.width, viewport.height)
    await testInfo.attach('status-menu', { body: await page.screenshot(), contentType: 'image/png' })
    await page.keyboard.press('Escape')
    await expect(submenu).not.toBeVisible()
    await status.focus()
    await page.keyboard.press('End')
    const last = page.getByRole('menuitem', { name: '删除任务…', exact: true })
    await expect(last).toBeFocused()
    await expectInsideViewport(last, viewport.width, viewport.height)
    await page.keyboard.press('Home')
    await expect(status).toBeFocused()
    await expectInsideViewport(status, viewport.width, viewport.height)
    await testInfo.attach('menu-first-item', { body: await page.screenshot(), contentType: 'image/png' })
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
    await expect(trigger).toBeFocused()
  })
}
