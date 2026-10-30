import { expect, test } from '@playwright/test'

/**
 * 设置 › Bot against the dev-only harness (mocked data, see lib/settings/bots-mock.ts).
 * Runs only when the server was started with MIKKA_SETTINGS_HARNESS=1.
 */
test.skip(process.env.MIKKA_SETTINGS_HARNESS !== '1', 'settings harness disabled')
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
  await expect(drawer.getByRole('link')).toHaveCount(3)
  const locked = drawer.locator('[data-thread-locked]')
  await expect(locked).toHaveText(/私有线程/)
  await expect(locked).not.toHaveText(/已完成|运行中/)
  await expect(locked).not.toHaveAttribute('tabindex')
  expect(await locked.evaluate(node => getComputedStyle(node).cursor)).toBe('auto')
  await drawer.getByRole('button', { name: '关闭' }).click()
  await expect(drawer).toBeHidden()
})

test('member: defaults are disabled', async ({ page }) => {
  await open(page, 'member')
  await expect(page.getByRole('combobox', { name: '模型' })).toBeDisabled()
  await expect(page.getByRole('combobox', { name: '代码仓库' })).toBeDisabled()
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
  await expect(page.getByRole('combobox', { name: '模型' })).toHaveText(/Mikka 默认/)
})
