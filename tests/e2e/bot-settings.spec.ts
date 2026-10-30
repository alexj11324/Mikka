import { test, expect, register, app } from './fixtures'

// docs/design/bot-settings.md: the admin governs 可用模型 in workspace settings; the bot's
// owner picks its model in the bot's 详情, only from what is allowed. Real app and database.
test('管理员设置可用模型，Bot 创建者只能在允许范围内选择模型', async ({ page }) => {
  // A new account is the admin of its own workspace.
  await register(page, '/settings?section=bots')
  const models = page.getByRole('region', { name: '可用模型', exact: true })
  const claude = models.getByRole('switch', { name: 'Claude', exact: true })
  await expect(claude).toBeChecked()
  await claude.click()
  await expect(claude).not.toBeChecked()
  await expect(claude).toBeEnabled()
  const starting = models.getByRole('combobox', { name: '新 Bot 的初始模型', exact: true })
  await starting.click()
  await expect(page.getByRole('option', { name: 'Claude', exact: true })).toHaveCount(0)
  await page.getByRole('option', { name: 'Codex', exact: true }).click()
  await expect(starting).toHaveText('Codex')
  await expect(starting).toBeEnabled()
  await page.reload()
  await expect(claude).not.toBeChecked()
  await expect(starting).toHaveText('Codex')
  // The last allowed family cannot be switched off.
  await models.getByRole('switch', { name: 'Mikka 默认', exact: true }).click()
  await expect(models.getByRole('switch', { name: 'Codex', exact: true })).toBeDisabled()
  await models.getByRole('switch', { name: 'Mikka 默认', exact: true }).click()
  await expect(models.getByRole('switch', { name: 'Codex', exact: true })).toBeEnabled()

  // Owner flow: a new bot starts on the starting model and offers only allowed families.
  await page.goto(app('/'))
  await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '新建 Bot' })
  await dialog.getByLabel('名字', { exact: true }).fill('设置 Bot')
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).toBeHidden()
  const panel = page.getByRole('complementary', { name: '右栏', exact: true })
  await panel.getByRole('tab', { name: '详情', exact: true }).click()
  const settings = panel.getByTestId('bot-settings')
  const model = settings.getByRole('combobox', { name: '模型', exact: true })
  await expect(model).toHaveText('Codex')
  await expect(settings.getByText('未连接 Codex 订阅', { exact: true })).toBeVisible()
  await model.click()
  await expect(page.getByRole('option', { name: 'Claude', exact: true })).toHaveCount(0)
  await page.getByRole('option', { name: 'Mikka 默认', exact: true }).click()
  await expect(model).toHaveText('Mikka 默认')
  await expect(settings.getByRole('combobox', { name: '仓库', exact: true })).toHaveText('无')
  await page.reload()
  await panel.getByRole('tab', { name: '详情', exact: true }).click()
  await expect(model).toHaveText('Mikka 默认')

  // 全部 Bot shows it read-only with its owner's choice.
  await page.goto(app('/settings?section=bots'))
  const all = page.getByRole('region', { name: '全部 Bot', exact: true })
  await all.getByText('设置 Bot', { exact: true }).click()
  const sheet = page.getByRole('dialog', { name: '设置 Bot', exact: true })
  await expect(sheet.getByTestId('bot-config')).toContainText('Mikka 默认')
  await expect(sheet.getByRole('combobox')).toHaveCount(0)
})
