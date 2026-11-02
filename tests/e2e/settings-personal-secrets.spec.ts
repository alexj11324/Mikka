import { test, expect, registerInTeam } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// 密钥与登录 › 我的 › 我的密钥 against the real stores (ephemeral WORKSPACE_SECRETS_KEY): a person's own
// secrets, write-only; a name the workspace already has asks once (decision 2026-11-02-2120).
test('我的密钥：添加、同名确认、改说明、批量添加和删除，值不回显', async ({ page }, testInfo) => {
  await registerInTeam(page, '/settings?section=secrets')
  // The workspace has VERCEL_TOKEN.
  await page.getByRole('button', { name: '添加', exact: true }).first().click()
  let sheet = page.getByRole('dialog', { name: '添加密钥' })
  await sheet.getByLabel('名称', { exact: true }).fill('VERCEL_TOKEN')
  await sheet.getByLabel('值', { exact: true }).fill(`team-${Date.now()}-value`)
  await sheet.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '保存', exact: true }).click()
  await expect(sheet).toHaveCount(0)

  await page.getByRole('group', { name: '密钥归属' }).getByRole('button', { name: '我的', exact: true }).click()
  const mine = page.getByRole('region', { name: '我的密钥' })
  await expect(mine.getByText('还没有密钥。')).toBeVisible()
  await expect(page.getByRole('region', { name: '网站登录' })).toBeVisible()
  await attachLightDark(page, testInfo, 'my-secrets-empty')

  const value = `mine-${Date.now()}-value`
  await mine.getByRole('button', { name: '添加', exact: true }).click()
  sheet = page.getByRole('dialog', { name: '添加我的密钥' })
  await expect(sheet.getByRole('button', { name: '仓库', exact: true })).toHaveCount(0)
  await sheet.getByLabel('名称', { exact: true }).fill('VERCEL_TOKEN')
  await sheet.getByLabel('值', { exact: true }).fill(value)
  await sheet.getByLabel('说明', { exact: true }).fill('我自己的预览项目')
  await sheet.getByRole('button', { name: '保存', exact: true }).click()
  const shadow = page.getByRole('alertdialog', { name: 'E2E 团队 已有 VERCEL_TOKEN，在你的运行里用你自己的值？' })
  await attachLightDark(page, testInfo, 'my-secrets-shadow')
  await shadow.getByRole('button', { name: '用我的', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  const table = mine.getByRole('table')
  await expect(table.getByRole('row').filter({ hasText: 'VERCEL_TOKEN' })).toContainText('我自己的预览项目')
  expect(await page.content()).not.toContain(value)

  // Bulk: a name the workspace has is asked about, the rest is added straight away.
  await mine.getByRole('button', { name: '批量添加', exact: true }).first().click()
  sheet = page.getByRole('dialog', { name: '批量添加' })
  await sheet.getByLabel('.env', { exact: true }).fill('OPENROUTER_API_KEY=or-mine-123456 # 测试\nDEBUG=1')
  await sheet.getByRole('button', { name: '添加 2 个', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已添加 2 个，替换 0 个，跳过 0 个。' })).toBeVisible()
  await expect(table.getByRole('row').filter({ hasText: 'OPENROUTER_API_KEY' })).toContainText('测试')
  await attachLightDark(page, testInfo, 'my-secrets-list')

  // Note-only edit, then delete with a confirmation.
  await table.getByRole('row').filter({ hasText: 'DEBUG' }).getByRole('button', { name: 'DEBUG 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
  sheet = page.getByRole('dialog', { name: 'DEBUG' })
  await sheet.getByLabel('说明', { exact: true }).fill('调试开关')
  await sheet.getByRole('button', { name: '保存', exact: true }).click()
  await expect(table.getByRole('row').filter({ hasText: 'DEBUG' })).toContainText('调试开关')
  await table.getByRole('row').filter({ hasText: 'DEBUG' }).getByRole('button', { name: 'DEBUG 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
  await page.getByRole('dialog', { name: 'DEBUG' }).getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('alertdialog', { name: '删除 DEBUG？' }).getByRole('button', { name: '删除', exact: true }).click()
  await expect(table.getByText('DEBUG')).toHaveCount(0)
  expect(await page.content()).not.toContain('or-mine-123456')
})
