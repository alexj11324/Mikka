import { test, expect, register, app } from './fixtures'

// Network failure is the action under test, not an ignored application exception.
test.use({ expectedConsoleErrors: [{ path: app('/'), message: 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED' }] })

for (const width of [1280, 402]) {
  for (const layout of ['board', 'list'] as const) {
    test(`offline refresh keeps ${layout} bounds stable at ${width}px`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 900 })
      await register(page)
      // Open the task view from the responsive navigation.
      if (width < 768) await page.getByRole('button', { name: '展开或收起侧栏', exact: true }).click()
      await page.getByRole('button', { name: '任务', exact: true }).click()
      await expect(page.getByRole('region', { name: '任务看板', exact: true })).toBeVisible()
      // The global create button lives in the closed mobile sidebar. Use the
      // visible board-column action on both breakpoints instead.
      await page.getByRole('region', { name: '任务看板', exact: true }).getByRole('button', { name: '新建待整理任务', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '新建任务', exact: true })
      const title = `Offline layout ${width} ${layout}`
      await dialog.getByLabel('任务标题', { exact: true }).fill(title)
      await dialog.getByRole('button', { name: '创建任务', exact: true }).click()
      await expect(dialog).not.toBeVisible()
      await expect(page.getByRole('region', { name: '任务看板', exact: true }).getByText(title, { exact: true })).toBeVisible()
      if (layout === 'list') await page.getByRole('button', { name: '列表视图', exact: true }).click()
      // The toolbar and content fill the same bounds in empty and populated views.
      const toolbar = page.getByRole('heading', { name: '全部任务', exact: true }).locator('..').locator('..')
      const content = layout === 'board'
        ? page.getByRole('region', { name: '任务看板', exact: true })
        : page.getByLabel('任务列表', { exact: true })
      await expect(content.getByText(title, { exact: true })).toBeVisible()
      const contentBefore = await content.boundingBox()
      expect(contentBefore).not.toBeNull()
      const before = await toolbar.boundingBox()
      expect(before).not.toBeNull()

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
        await expect.poll(() => toolbar.boundingBox()).toEqual(before)
        await expect.poll(() => content.boundingBox()).toEqual(contentBefore)
        if (layout === 'board') await expect(page.getByRole('region', { name: '任务看板', exact: true })).toBeVisible()
        await context.setOffline(false)
        await expect(notice).toHaveCount(0, { timeout: 20000 })
        await expect.poll(() => toolbar.boundingBox()).toEqual(before)
        await expect.poll(() => content.boundingBox()).toEqual(contentBefore)
      } finally {
        await context.setOffline(false)
        await page.unroute('**/mikka')
      }
    })
  }
}
