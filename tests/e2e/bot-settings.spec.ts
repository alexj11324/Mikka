import { test, expect, register, app, seedTurnError } from './fixtures'
import type { Locator, Page, TestInfo } from '@playwright/test'

/** Design review evidence: the same state in light and dark. */
async function shots(page: Page, testInfo: TestInfo, name: string, target: Locator) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await testInfo.attach(`${name}-${colorScheme}`, { body: await target.screenshot(), contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

// docs/design/bot-settings.md: the admin governs 可用模型 in workspace settings; the bot's
// owner picks its model in the bot's 详情, only from what is allowed. Real app and database.
test('管理员设置可用模型，Bot 创建者只能在允许范围内选择模型', async ({ page }, testInfo) => {
  // A new account is the admin of its own workspace.
  await register(page, '/settings?section=bots')
  const models = page.getByRole('region', { name: '可用模型', exact: true })
  const claude = models.getByRole('switch', { name: 'Claude', exact: true })
  await expect(claude).toBeChecked()
  await shots(page, testInfo, 'allowlist-default', models)
  await claude.click()
  await expect(claude).not.toBeChecked()
  await expect(claude).toBeEnabled()
  const starting = models.getByRole('combobox', { name: '新 Bot 的初始模型', exact: true })
  await starting.click()
  await expect(page.getByRole('option', { name: 'Claude', exact: true })).toHaveCount(0)
  await shots(page, testInfo, 'starting-model-menu', page.getByRole('listbox'))
  await page.getByRole('option', { name: 'Codex', exact: true }).click()
  await expect(starting).toHaveText('Codex')
  await expect(starting).toBeEnabled()
  await page.reload()
  await expect(claude).not.toBeChecked()
  await expect(starting).toHaveText('Codex')
  // The last allowed family cannot be switched off.
  await models.getByRole('switch', { name: 'Mikka 默认', exact: true }).click()
  await expect(models.getByRole('switch', { name: 'Codex', exact: true })).toBeDisabled()
  await shots(page, testInfo, 'allowlist-last-family', models)
  await models.getByRole('switch', { name: 'Mikka 默认', exact: true }).click()
  await expect(models.getByRole('switch', { name: 'Codex', exact: true })).toBeEnabled()
  await starting.click()
  await page.getByRole('option', { name: 'Mikka 默认', exact: true }).click()
  await expect(starting).toHaveText('Mikka 默认')

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
  await expect(model).toHaveText('Mikka 默认')
  await expect(settings.getByRole('combobox', { name: '仓库', exact: true })).toHaveText('无')
  await shots(page, testInfo, 'bot-details-settings', settings)
  await model.click()
  await expect(page.getByRole('option', { name: 'Claude', exact: true })).toHaveCount(0)
  await expect(page.getByRole('option', { name: 'Mikka 默认', exact: true })).toBeVisible()
  await shots(page, testInfo, 'bot-model-menu', page.getByRole('listbox'))
  await page.keyboard.press('Escape')
  await page.reload()
  await panel.getByRole('tab', { name: '详情', exact: true }).click()
  await expect(model).toHaveText('Mikka 默认')

  // A turn refused for the bot's model shows in the chat with its fix (failTurn's lastError, as the workflow stores it).
  const botId = new URL(page.url()).searchParams.get('bot')!
  await seedTurnError(page, botId, 'botModel:binding_required:codex')
  await page.reload()
  const refusal = page.getByTestId('bot-model-refusal')
  await expect(refusal).toContainText('回复失败')
  await expect(refusal).toContainText('未连接 Codex 订阅')
  await expect(refusal.getByRole('link', { name: '模型订阅', exact: true })).toHaveAttribute('href', /section=models/)
  await shots(page, testInfo, 'turn-refused-subscription', refusal)
  await seedTurnError(page, botId, 'botModel:backend_unavailable:claude')
  await page.reload()
  await expect(refusal).toContainText('Claude 在此无法运行')
  await shots(page, testInfo, 'turn-refused-model', refusal)
  await panel.getByRole('tab', { name: '线程', exact: true }).click()
  await refusal.getByRole('button', { name: '更换模型', exact: true }).click()
  await expect(panel.getByTestId('bot-settings')).toBeVisible()

  // 全部 Bot shows it read-only with its owner's choice.
  await page.goto(app('/settings?section=bots'))
  const all = page.getByRole('region', { name: '全部 Bot', exact: true })
  await shots(page, testInfo, 'all-bots', all)
  await all.getByText('设置 Bot', { exact: true }).click()
  const sheet = page.getByRole('dialog', { name: '设置 Bot', exact: true })
  await expect(sheet.getByTestId('bot-config')).toContainText('Mikka 默认')
  await expect(sheet.getByRole('combobox')).toHaveCount(0)
  await shots(page, testInfo, 'all-bots-sheet', sheet)
})
