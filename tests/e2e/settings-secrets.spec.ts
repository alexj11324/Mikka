import { test, expect, register } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// N5 密钥与环境 (Figma 554:9120) against the real secrets store (ephemeral WORKSPACE_SECRETS_KEY in CI).
test('管理员添加、编辑和删除密钥，值不回显', async ({ page }, testInfo) => {
  await register(page, '/settings?section=secrets')
  await expect(page.getByRole('heading', { level: 1, name: '密钥与环境' })).toBeVisible()
  await expect(page.getByText('还没有密钥。')).toBeVisible()
  // BYO E2B: write-only, the row names its state only.
  const e2b = page.getByRole('region', { name: '云电脑' })
  await expect(e2b.getByRole('status')).toHaveText('未设置')
  await e2b.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'E2B API Key' }).getByLabel('API Key')).toHaveValue('')
  await attachLightDark(page, testInfo, 'secrets-e2b-dialog')
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  await attachLightDark(page, testInfo, 'secrets-empty')

  const value = `e2e-${Date.now()}-value`
  await page.getByRole('button', { name: '添加', exact: true }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '名称' }).fill('VERCEL_TOKEN')
  await dialog.getByLabel('值').fill(value)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('group', { name: '工作区' }).getByText('VERCEL_TOKEN')).toBeVisible()

  await page.getByRole('button', { name: '添加', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox', { name: '类型' }).click()
  await page.getByRole('option', { name: '环境变量' }).click()
  await dialog.getByRole('textbox', { name: '名称' }).fill('NODE_ENV')
  await dialog.getByLabel('值').fill('production')
  // No environment selector: an entry is scoped to the workspace or one repository only.
  await expect(dialog.getByRole('combobox', { name: '环境' })).toHaveCount(0)
  await dialog.getByRole('combobox', { name: '范围' }).click()
  await page.getByRole('option', { name: '仓库' }).click()
  await dialog.getByRole('textbox', { name: '仓库' }).fill('alexj11324/mikka')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const repo = page.getByRole('group', { name: '仓库 alexj11324/mikka' })
  await expect(repo.getByText('NODE_ENV')).toBeVisible()
  expect(await page.content()).not.toContain(value)
  await attachLightDark(page, testInfo, 'secrets-list')

  await page.getByRole('button', { name: '编辑 VERCEL_TOKEN', exact: true }).click()
  dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('新的值')).toHaveValue('')
  await attachLightDark(page, testInfo, 'secrets-edit')
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText('VERCEL_TOKEN')).toHaveCount(0)
})
