import { expect, test } from '@playwright/test'

/**
 * 设置 › Bot against the dev-only harness (mocked data, see lib/settings/bots-mock-data.ts).
 * Playwright's own webServer enables the harness; against an external E2E_BASE_URL
 * it runs only when that server was started with MIKKA_SETTINGS_HARNESS=1.
 */
test.skip(!!process.env.E2E_BASE_URL && process.env.MIKKA_SETTINGS_HARNESS !== '1', 'settings harness disabled')
const open = (page: import('@playwright/test').Page, state = 'default') => page.goto(`/mikka/zh-CN/preview/settings-harness/bots?state=${state}`)

test('admin: defaults, bot list and thread drawer', async ({ page }) => {
  await open(page)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bot')
  await expect(page.getByRole('heading', { name: '新 Bot 默认值' })).toBeVisible()
  const model = page.getByRole('combobox', { name: '模型' })
  await expect(model).toHaveText(/Mikka 默认/)
  await model.click()
  await expect(page.getByRole('option')).toHaveText(['Mikka 默认', 'Codex', 'Claude'])
  await page.getByRole('option', { name: 'Codex' }).click()
  await expect(page.getByText('已保存')).toBeVisible()

  await page.getByRole('combobox', { name: '代码仓库' }).click()
  await expect(page.getByRole('option', { name: '连接另一个仓库…' })).toBeVisible()
  await page.keyboard.press('Escape')

  await expect(page.getByText('运行中 · 2 个线程')).toBeVisible()
  await page.getByRole('button', { name: /Coordinator/ }).click()
  const drawer = page.getByRole('dialog', { name: '线程列表' })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('Coordinator · 空闲')).toBeVisible()
  await expect(drawer.getByRole('link')).toHaveCount(2)
  const locked = drawer.locator('[data-thread-locked]')
  await expect(locked).toHaveText(/私有线程/)
  await expect(locked).not.toHaveText(/已完成|运行中/)
  await expect(locked).not.toHaveAttribute('tabindex')
  expect(await locked.evaluate(node => getComputedStyle(node).cursor)).toBe('auto')
  await drawer.getByRole('button', { name: '关闭' }).click()
  await expect(drawer).toBeHidden()
})

test('member: defaults are shown as values, not controls', async ({ page }) => {
  await open(page, 'member')
  const defaults = page.getByRole('region', { name: '新 Bot 默认值' })
  await expect(defaults.getByText('Mikka 默认')).toBeVisible()
  await expect(defaults.getByText('alexj11324/mikka')).toBeVisible()
  await expect(defaults.getByRole('combobox')).toHaveCount(0)
})

test('overlapping saves: a slow failure never undoes a newer choice', async ({ page }) => {
  await open(page, 'saveRace')
  const model = page.getByRole('combobox', { name: '模型' })
  await model.click()
  await page.getByRole('option', { name: 'Codex' }).click() // pending, fails after a delay
  await model.click()
  await page.getByRole('option', { name: 'Claude' }).click() // succeeds at once
  await expect(page.getByText('已保存')).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(model).toHaveText(/Claude/)
  await expect(page.getByRole('alert').filter({ hasText: '操作未成功' })).toHaveCount(0)
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: '操作未成功' })).toHaveCount(0)
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: '已保存' })).toHaveCount(1)
})

test('thread drawer pages with a cursor; a failed next page can be retried', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: /Frontend/ }).click()
  const drawer = page.getByRole('dialog', { name: '线程列表' })
  const rows = drawer.locator('[data-slot="item"]')
  await expect(rows).toHaveCount(20)
  await drawer.getByRole('button', { name: '加载更多' }).dblclick()
  await expect(rows).toHaveCount(25)
  await expect(drawer.getByRole('button', { name: '加载更多' })).toHaveCount(0)

  await open(page, 'moreError')
  await page.getByRole('button', { name: /Frontend/ }).click()
  await expect(rows).toHaveCount(20)
  await drawer.getByRole('button', { name: '加载更多' }).click()
  await expect(drawer.getByRole('alert')).toBeVisible()
  await expect(rows).toHaveCount(20)
})

test('loading, empty, load error and save error states', async ({ page }) => {
  await open(page, 'loading')
  await expect(page.getByRole('status', { name: '新 Bot 默认值' })).toBeVisible()
  await open(page, 'empty')
  await expect(page.getByText('还没有 Bot')).toBeVisible()
  await open(page, 'error')
  await expect(page.getByRole('alert')).toBeVisible()
  await open(page, 'saveError')
  await page.getByRole('combobox', { name: '模型' }).click()
  await page.getByRole('option', { name: 'Claude' }).click()
  await expect(page.getByRole('alert').filter({ hasText: '操作未成功' })).toBeVisible()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: '操作未成功' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '模型' })).toHaveText(/Mikka 默认/)
})
