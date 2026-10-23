import { test, expect, register, app, openCreateIssue } from './fixtures'

// Network failure is the action under test, not an ignored application exception.
test.use({ trace: 'on', expectedConsoleErrors: [{ path: app('/'), message: 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED' }] })

for (const width of [1280, 402]) {
  // The board is the only task layout since the Figma v3.1 shell (no list toggle).
  for (const layout of ['board'] as const) {
    test(`offline refresh keeps ${layout} bounds stable at ${width}px`, async ({ page, context }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await register(page)
      // Use main's responsive rail: phones expose it inside the sidebar.
      if (width < 768) {
        await page.getByRole('button', { name: '展开或收起侧栏', exact: true }).click()
        await page.locator('[data-slot="sidebar"][data-mobile="true"]').getByRole('button', { name: '看板', exact: true }).click()
      } else {
        await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '看板', exact: true }).click()
      }
      await expect(page.getByRole('region', { name: '任务看板', exact: true })).toBeVisible()
      const dialog = await openCreateIssue(page)
      const title = `Offline layout ${width} ${layout}`
      await dialog.getByLabel('任务标题', { exact: true }).fill(title)
      await dialog.getByRole('button', { name: '创建任务', exact: true }).click()
      await expect(dialog).not.toBeVisible()
      await expect(page.getByRole('region', { name: '任务看板', exact: true }).getByRole('group', { name: title, exact: true })).toBeVisible()
      // The toolbar and content fill the same bounds in empty and populated views.
      const toolbar = page.getByRole('heading', { name: '看板', exact: true }).locator('..').locator('..')
      const content = page.getByRole('region', { name: '任务看板', exact: true })
      await expect(content.getByRole('group', { name: title, exact: true })).toBeVisible()
      const contentBefore = await content.boundingBox()
      expect(contentBefore).not.toBeNull()
      const before = await toolbar.boundingBox()
      expect(before).not.toBeNull()

      const capture = async (name: string) => {
        const path = testInfo.outputPath(`${name}.png`)
        await page.screenshot({ path, fullPage: true })
        await testInfo.attach(name, { path, contentType: 'image/png' })
      }
      await capture('online-before')

      // SWR intentionally pauses polling once navigator.onLine is false. Cut an
      // in-flight refresh instead, as happens when a real connection drops.
      await page.route('**/mikka', async route => {
        if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue()
        await context.setOffline(true)
        await route.abort('internetdisconnected')
      }, { times: 1 })
      const notice = page.locator('[data-sonner-toast]').filter({ hasText: '列表更新失败' })
      try {
        await expect(notice).toBeVisible({ timeout: 30000 })
        await expect(notice).toHaveAttribute('data-mounted', 'true')
        // A visible DOM box can still be below the viewport during Sonner's
        // entry transition. Capture the fully entered notice, not that frame.
        await notice.evaluate(async element => {
          await Promise.all(element.getAnimations().map(animation => animation.finished))
        })
        await expect(notice).toBeInViewport()
        await expect.poll(() => toolbar.boundingBox()).toEqual(before)
        await expect.poll(() => content.boundingBox()).toEqual(contentBefore)
        await capture('offline-notice')
        await expect(page.getByRole('region', { name: '任务看板', exact: true })).toBeVisible()
        await context.setOffline(false)
        await expect(notice).toHaveCount(0, { timeout: 20000 })
        await expect.poll(() => toolbar.boundingBox()).toEqual(before)
        await expect.poll(() => content.boundingBox()).toEqual(contentBefore)
        await capture('online-recovered')
      } finally {
        await context.setOffline(false)
        await page.unroute('**/mikka')
      }
    })
  }
}
