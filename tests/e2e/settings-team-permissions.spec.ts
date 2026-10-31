import { test, expect, register, registerInTeam, seedTeamWorkspace, app } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// N4 团队权限 (Figma 554:8760) › 允许使用的应用 against the real policy table.
test('管理员可以禁止某个应用，刷新后保持', async ({ page }, testInfo) => {
  await registerInTeam(page, '/settings?section=permissions')
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

// Decision 2026-10-31-2225: members share their own subscriptions into a team; an admin has one switch, on by default.
test('团队管理员可以不允许成员使用个人订阅，成员自己的共享开关随之关闭', async ({ page }) => {
  await register(page, '/')
  const workspace = await seedTeamWorkspace(page)
  await page.goto(app(`/settings?section=models&workspace=${workspace}`))
  const share = page.getByRole('switch', { name: '在这里使用我的订阅', exact: true })
  await expect(share).not.toBeChecked()
  await share.click()
  await expect(share).toBeChecked()
  await page.goto(app(`/settings?section=permissions&workspace=${workspace}`))
  await expect(page.getByRole('heading', { level: 2, name: '个人订阅' })).toBeVisible()
  const allowed = page.getByRole('switch', { name: '允许成员使用个人订阅', exact: true })
  await expect(allowed).toBeChecked()
  await allowed.click()
  await expect(allowed).not.toBeChecked()
  await page.reload()
  await expect(page.getByRole('switch', { name: '允许成员使用个人订阅', exact: true })).not.toBeChecked()
  await page.goto(app(`/settings?section=models&workspace=${workspace}`))
  await expect(page.getByText('管理员已关闭', { exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: '在这里使用我的订阅', exact: true })).toHaveCount(0)
})
