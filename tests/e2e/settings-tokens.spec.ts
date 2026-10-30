import { test, expect, register } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// N3 个人访问令牌 (Figma 554:8440) against the real token store.
test('新建令牌只显示一次明文，撤销后从列表消失', async ({ page }, testInfo) => {
  await register(page, '/settings?section=developer')
  await expect(page.getByRole('heading', { level: 1, name: '个人访问令牌' })).toBeVisible()
  await expect(page.getByText('还没有令牌。')).toBeVisible()
  await attachLightDark(page, testInfo, 'tokens-empty')

  await page.getByRole('button', { name: '新建', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '名称' }).fill('CLI · MacBook')
  await dialog.getByRole('button', { name: '新建', exact: true }).click()
  const token = dialog.getByRole('textbox', { name: '令牌' })
  await expect(token).toHaveValue(/^mkp_[A-Za-z0-9_-]{43}$/)
  const plaintext = await token.inputValue()
  await attachLightDark(page, testInfo, 'tokens-created')
  await dialog.getByRole('button', { name: '完成', exact: true }).click()

  await expect(page.getByText('CLI · MacBook', { exact: true })).toBeVisible()
  await expect(page.getByText(/从未使用 · .*过期/)).toBeVisible()
  expect(await page.content()).not.toContain(plaintext)
  await attachLightDark(page, testInfo, 'tokens-list')

  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.getByText('CLI · MacBook', { exact: true })).toHaveCount(0)
  await expect(page.getByText('还没有令牌。')).toBeVisible()
})
