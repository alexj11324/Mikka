import { test, expect, register } from './fixtures'
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
