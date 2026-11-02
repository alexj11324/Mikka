import type { Request } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, register, registerInTeam, seedTeamWorkspace, app, browserClientHeaders, watchRuntime } from './fixtures'

let pool: Pool | null = null
const db = () => pool ??= new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
test.afterAll(async () => { await pool?.end() })
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

// Decision 2026-11-01-2240: a member's own subscriptions always serve them; the one thing an admin can turn off
// is sharing with teammates (团队权限 › 订阅与 API Key), 允许 by default.
test('管理员可以禁止成员把订阅分享给队友，自己的照常能用', async ({ page }) => {
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
  await expect(page.getByRole('heading', { level: 2, name: '订阅与 API Key' })).toBeVisible()
  await expect(page.getByText('禁止后只停用分享给别人的部分，每个人自己照常能用')).toBeVisible()
  // The old switch over a member's own use is gone (#966).
  await expect(page.getByRole('switch', { name: '允许成员使用个人订阅和 API Key', exact: true })).toHaveCount(0)
  const sharing = page.getByRole('group', { name: '成员把自己的订阅和 API Key 分享给队友', exact: true })
  await expect(sharing.getByRole('button', { name: '允许', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await sharing.getByRole('button', { name: '禁止', exact: true }).click()
  await expect(sharing.getByRole('button', { name: '禁止', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(sharing.getByRole('button', { name: '禁止', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await page.goto(app(`/settings?section=models&workspace=${workspace}`))
  await expect(page.getByText('管理员已关闭', { exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: '分享给团队成员', exact: true })).toHaveCount(0)
})

// A real member, not a faked response: 团队权限 is admin-only, so a member gets no
// 允许 / 禁止 control there, and the server refuses the same writes when the member
// sends the admin's own requests (workspaceAccessDenied), leaving both policies as they were.
test('非管理员成员没有团队权限的允许/禁止，直接调用写接口被拒绝', async ({ page, browser, baseURL }) => {
  await register(page, '/')
  const workspace = await seedTeamWorkspace(page)
  await page.goto(app(`/settings?section=permissions&workspace=${workspace}`))
  const slack = page.getByRole('group', { name: 'Slack', exact: true })
  const sharing = page.getByRole('group', { name: '成员把自己的订阅和 API Key 分享给队友', exact: true })
  const isAction = (request: Request) => request.method() === 'POST' && Boolean(request.headers()['next-action'])

  // The admin's real writes, kept to replay as the member; then both back to 允许.
  const [appWrite] = await Promise.all([page.waitForRequest(isAction), slack.getByRole('button', { name: '禁止', exact: true }).click()])
  await expect(slack.getByRole('button', { name: '禁止', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const [shareWrite] = await Promise.all([page.waitForRequest(isAction), sharing.getByRole('button', { name: '禁止', exact: true }).click()])
  await expect(sharing.getByRole('button', { name: '禁止', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await slack.getByRole('button', { name: '允许', exact: true }).click()
  await expect(slack.getByRole('button', { name: '允许', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await sharing.getByRole('button', { name: '允许', exact: true }).click()
  await expect(sharing.getByRole('button', { name: '允许', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const policies = async () => ({
    slack: (await db().query<{ access: string }>('SELECT access FROM workspace_app_policies WHERE "workspaceId" = $1 AND app = $2', [workspace, 'slack'])).rows[0]?.access ?? 'allow',
    sharing: (await db().query<{ subscriptions: boolean }>('SELECT subscriptions FROM workspace_personal_policies WHERE "workspaceId" = $1', [workspace])).rows[0]?.subscriptions ?? true,
  })
  expect(await policies()).toEqual({ slack: 'allow', sharing: true })

  const memberContext = await browser.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
  const errors = watchRuntime(memberContext)
  try {
    const memberPage = await memberContext.newPage()
    const { email } = await register(memberPage, '/')
    await db().query(`INSERT INTO mikka_workspace_members ("workspaceId", "userId", name, email, role)
      SELECT $1, id, name, lower(email), 'member' FROM "user" WHERE lower(email) = lower($2)`, [workspace, email])

    await memberPage.goto(app(`/settings?section=permissions&workspace=${workspace}`))
    await expect(memberPage.getByRole('heading', { level: 2, name: '设置' })).toBeVisible()
    await expect(memberPage.getByRole('link', { name: '团队权限', exact: true })).toHaveCount(0)
    await expect(memberPage.getByRole('button', { name: /^(允许|禁止)$/ })).toHaveCount(0)
    await expect(memberPage.getByRole('group', { name: 'Slack', exact: true })).toHaveCount(0)

    for (const write of [appWrite, shareWrite]) {
      const headers = write.headers()
      const response = await memberPage.request.post(write.url(), {
        headers: { 'next-action': headers['next-action'], 'content-type': headers['content-type'], accept: headers.accept ?? 'text/x-component', origin: new URL(write.url()).origin },
        data: write.postDataBuffer() ?? undefined,
      })
      expect(response.status()).toBe(200)
      expect(await response.text()).toContain('workspaceAccessDenied')
    }
    expect(await policies()).toEqual({ slack: 'allow', sharing: true })
    expect(errors).toEqual([])
  } finally {
    await memberContext.close()
  }
})

