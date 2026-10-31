import { test, expect, register } from './fixtures'

/**
 * D12: the display name was a read-only span. It is an input that saves in
 * place and survives a reload.
 */
test('个人资料名称可以编辑，保存后刷新仍然生效', { tag: '@smoke' }, async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  const sidebar = page.locator('[data-slot="settings-list"]')
  await sidebar.getByRole('link', { name: '账户', exact: true }).click()

  const name = page.getByRole('textbox', { name: '名称', exact: true })
  await expect(name).toHaveValue('回归测试成员')
  await name.fill('新的显示名')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()

  await page.reload()
  await page.locator('[data-slot="settings-list"]').getByRole('link', { name: '账户', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('新的显示名')
})

// D14: the language row was a span. Choosing English switches the interface.
test('切换界面语言后进入英文界面', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByRole('group', { name: '界面语言', exact: true }).getByRole('button', { name: 'English', exact: true }).click()
  await expect(page).toHaveURL(/\/en\//)
  await expect(page.getByRole('heading', { name: 'Preferences', exact: true })).toBeVisible()
})

// D16: the web Settings page now has the notification settings the phone has.
test('通知设置可以关闭主动消息，刷新后保持', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  const sidebar = () => page.locator('[data-slot="settings-list"]')
  await sidebar().getByRole('link', { name: '通知', exact: true }).click()

  const proactive = page.getByRole('switch', { name: '主动消息', exact: true })
  await expect(proactive).toBeChecked()
  await proactive.click()
  await expect(proactive).not.toBeChecked()

  await page.reload()
  await sidebar().getByRole('link', { name: '通知', exact: true }).click()
  await expect(page.getByRole('switch', { name: '主动消息', exact: true })).not.toBeChecked()
})

// S-O: a refused save puts the switch back and offers a retry that sends the same change.
test.describe('通知保存失败', () => {
  // The test aborts the save itself; Chromium logs that aborted server-action POST once.
  test.use({ expectedConsoleErrors: [{ path: '/mikka/settings?section=notifications', message: 'Failed to load resource: net::ERR_FAILED' }] })

test('通知保存失败时开关恢复原值，重试后保存成功', async ({ page }) => {
  await register(page, '/settings?section=notifications')
  const proactive = page.getByRole('switch', { name: '主动消息', exact: true })
  await expect(proactive).toBeChecked()
  // Server actions POST with a Next-Action header; drop exactly those.
  await page.route('**/*', route => route.request().headers()['next-action'] ? route.abort() : route.continue())
  await proactive.click()
  await expect(page.locator('[data-slot="alert"]')).toContainText('这项设置没有保存，已恢复为原来的值。')
  await expect(proactive).toBeChecked()
  await page.unroute('**/*')
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.locator('[data-slot="alert"]')).toHaveCount(0)
  await expect(proactive).not.toBeChecked()
  await page.reload()
  await expect(page.getByRole('switch', { name: '主动消息', exact: true })).not.toBeChecked()
})
})

// D14 follow-up: switching language keeps the section and the workspace in the URL.
test('切换界面语言后停留在同一个设置分区', async ({ page }) => {
  await register(page, '/settings?section=preferences')
  await page.getByRole('group', { name: '界面语言', exact: true }).getByRole('button', { name: 'English', exact: true }).click()
  await expect(page).toHaveURL(/\/en\/settings\?.*section=preferences/)
  await expect(page.getByRole('heading', { name: 'Preferences', exact: true })).toBeVisible()
})
