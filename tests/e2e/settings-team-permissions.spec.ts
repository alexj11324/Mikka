import { test, expect, register, seedTeamWorkspace, app } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// N4 团队权限 (Figma 554:8760) › 允许使用的应用 against the real policy table.
test('管理员可以禁止某个应用，刷新后保持', async ({ page }, testInfo) => {
  await register(page, '/settings?section=permissions')
  await expect(page.getByRole('heading', { level: 1, name: '团队权限' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: '允许使用的应用' })).toBeVisible()
  const slack = page.getByRole('combobox', { name: 'Slack', exact: true })
  await expect(slack).toContainText('允许')
  await attachLightDark(page, testInfo, 'team-permissions')

  await slack.click()
  await page.getByRole('option', { name: '禁止', exact: true }).click()
  await expect(slack).toContainText('禁止')
  await page.reload()
  await expect(slack).toContainText('禁止')
  await expect(page.getByRole('combobox', { name: 'Gmail', exact: true })).toContainText('允许')
  await attachLightDark(page, testInfo, 'team-permissions-slack-blocked')
})

// Decision 2026-10-31-2130: a team admin can switch members' personal subscriptions, app connections and devices off; on by default.
test('团队管理员可以关闭成员的个人订阅，刷新后保持', async ({ page }) => {
  await register(page, '/')
  const workspace = await seedTeamWorkspace(page)
  await page.goto(app(`/settings?section=permissions&workspace=${workspace}`))
  await expect(page.getByRole('heading', { level: 2, name: '成员的个人账号' })).toBeVisible()
  const subscriptions = page.getByRole('switch', { name: '个人订阅', exact: true })
  for (const name of ['个人订阅', '个人应用连接', '个人设备']) await expect(page.getByRole('switch', { name, exact: true })).toBeChecked()
  await subscriptions.click()
  await expect(subscriptions).not.toBeChecked()
  await page.reload()
  await expect(page.getByRole('switch', { name: '个人订阅', exact: true })).not.toBeChecked()
  await expect(page.getByRole('switch', { name: '个人设备', exact: true })).toBeChecked()
})
