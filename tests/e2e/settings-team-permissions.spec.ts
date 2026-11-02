import { test, expect, register, registerInTeam, seedTeamWorkspace, app } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// N4 团队权限 (Figma 554:8760) › 允许使用的应用 against the real policy table.
test('管理员可以禁止某个应用，刷新后保持', async ({ page }, testInfo) => {
  await registerInTeam(page, '/settings?section=permissions')
  await expect(page.getByRole('heading', { level: 1, name: '团队权限' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: '允许使用的应用' })).toBeVisible()
  // The same 允许 / 禁止 segmented control as 电脑操作 (settings evaluation P2).
  const slack = page.getByRole('group', { name: 'Slack', exact: true })
  await expect(slack.getByRole('button', { name: '允许', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await attachLightDark(page, testInfo, 'team-permissions')

  await slack.getByRole('button', { name: '禁止', exact: true }).click()
  await expect(slack.getByRole('button', { name: '禁止', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(slack.getByRole('button', { name: '禁止', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('group', { name: 'Gmail', exact: true }).getByRole('button', { name: '允许', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await attachLightDark(page, testInfo, 'team-permissions-slack-blocked')
})

// Decision 2026-11-01-2240: a member's own subscriptions always serve them, and 团队权限 has no switch for them;
// only 分享给团队成员 is a choice, and it stays on.
test('团队权限没有个人订阅开关，成员的共享开关保持打开', async ({ page }) => {
  await register(page, '/')
  const workspace = await seedTeamWorkspace(page)
  await page.goto(app(`/settings?section=models&workspace=${workspace}`))
  // Own subscriptions serve their owner everywhere with no switch (#838); only 分享给团队成员 is a choice.
  await expect(page.getByRole('switch', { name: '在这里使用我的订阅', exact: true })).toHaveCount(0)
  const share = page.getByRole('switch', { name: '分享给团队成员', exact: true })
  await expect(share).not.toBeChecked()
  await share.click()
  await page.getByRole('alertdialog').getByRole('button', { name: '分享', exact: true }).click()
  await expect(share).toBeChecked()
  await page.goto(app(`/settings?section=permissions&workspace=${workspace}`))
  await expect(page.getByRole('heading', { level: 2, name: '允许使用的应用' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: '个人订阅' })).toHaveCount(0)
  await expect(page.getByRole('switch', { name: '允许成员使用个人订阅和 API Key', exact: true })).toHaveCount(0)
  await page.goto(app(`/settings?section=models&workspace=${workspace}`))
  await expect(page.getByRole('switch', { name: '分享给团队成员', exact: true })).toBeChecked()
})
