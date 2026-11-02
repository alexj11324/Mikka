import { test, expect, register } from './fixtures'

// A page left open across a deploy (a desktop window or a long-lived tab):
// components/version-guard.tsx and lib/app-build.ts. The deploy is stood in
// for at the network: a newer /api/version, then a server action the server no
// longer has (Next answers 404 with x-nextjs-action-not-found).
test('打开很久的页面：新部署后提示「Mikka 已更新 · 刷新」，已删除的 server action 自动刷新而不报错', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await register(page)
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Mikka 已更新' })
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible()
  await expect(toast).toHaveCount(0)

  await page.route('**/api/version', route => route.fulfill({ json: { build: 'dpl_newer' }, headers: { 'cache-control': 'no-store' } }))
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
  await expect(toast).toBeVisible()
  await expect(toast.getByRole('button', { name: '刷新', exact: true })).toBeVisible()
  const corner = await toast.boundingBox()
  const clip = { x: Math.max(0, corner!.x - 24), y: Math.max(0, corner!.y - 24), width: corner!.width + 48, height: corner!.height + 48 }
  await testInfo.attach('updated-toast-light', { body: await page.screenshot({ clip }), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  await testInfo.attach('updated-toast-dark', { body: await page.screenshot({ clip }), contentType: 'image/png' })
  await page.emulateMedia({ colorScheme: 'light' })

  await Promise.all([page.waitForEvent('load'), toast.getByRole('button', { name: '刷新', exact: true }).click()])
  await page.unroute('**/api/version')
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible()

  // The next server action the page calls is gone from the server: the page
  // reloads once instead of showing a read error.
  let missing = 0
  await page.route('**/*', async route => {
    const request = route.request()
    if (missing === 0 && request.method() === 'POST' && request.headers()['next-action']) {
      missing += 1
      await route.fulfill({ status: 404, headers: { 'x-nextjs-action-not-found': '1', 'content-type': 'text/plain' }, body: 'Server action not found.' })
      return
    }
    await route.fallback()
  })
  const reloaded = page.waitForEvent('load')
  await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '看板', exact: true }).click()
  await reloaded
  expect(missing).toBe(1)
  await expect(page.getByText(/无法读取|读取失败/)).toHaveCount(0)
})
