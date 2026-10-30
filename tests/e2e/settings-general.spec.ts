import { randomUUID } from 'node:crypto'
import { test, expect, register } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// V10 常规 and S-I 删除工作区 (Figma 551:7960, 551:9716) against the real backend.
test('管理员可以改名、改地址并删除工作区', async ({ page }, testInfo) => {
  await register(page, '/settings?section=general')
  await expect(page.getByRole('heading', { level: 1, name: '常规' })).toBeVisible()
  const name = page.getByRole('textbox', { name: '名称', exact: true })
  const address = page.getByRole('textbox', { name: '地址', exact: true })
  await expect(name).toBeEditable()
  await attachLightDark(page, testInfo, 'general-admin')

  const renamed = `E2E ${randomUUID().slice(0, 6)}`
  await name.fill(renamed)
  await name.press('Enter')
  await expect(name).toHaveValue(renamed)
  const slug = `e2e-${randomUUID().slice(0, 8)}`
  await address.fill(slug)
  await address.press('Enter')
  await expect(address).toHaveValue(slug)
  await page.reload()
  await expect(name).toHaveValue(renamed)
  await expect(address).toHaveValue(slug)

  await address.fill('-bad-')
  await address.press('Enter')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(address).toHaveValue(slug)
  await attachLightDark(page, testInfo, 'general-save-failed')

  await page.getByRole('button', { name: '删除', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: `删除「${renamed}」？` })).toBeVisible()
  await expect(dialog.getByText(/个 Bot、它们的线程和云电脑/)).toBeVisible()
  const confirm = dialog.getByRole('button', { name: '删除工作区', exact: true })
  await expect(confirm).toBeDisabled()
  await attachLightDark(page, testInfo, 'general-delete-dialog')
  await dialog.getByRole('textbox').fill(renamed)
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(page).not.toHaveURL(/section=general/)
})
