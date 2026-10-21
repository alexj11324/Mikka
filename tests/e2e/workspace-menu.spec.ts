import { randomBytes, randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { test, expect, register, browserClientHeaders, watchRuntime } from './fixtures'

async function openSwitcher(page: Page) {
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '切换工作区', exact: true }).hover()
  const switcher = page.getByRole('menu', { name: '切换工作区', exact: true })
  await expect(switcher.getByRole('menuitem', { name: '创建或加入工作区', exact: true })).toBeVisible()
  return switcher
}

async function openWorkspaceDialog(page: Page) {
  const switcher = await openSwitcher(page)
  await switcher.getByRole('menuitem', { name: '创建或加入工作区', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建或加入工作区', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

async function selectedWorkspace(page: Page) {
  const response = await page.request.get('/api/workspace/switcher')
  expect(response.ok()).toBeTruthy()
  const data = await response.json()
  return data.workspace as { id: string; name: string }
}

test('菜单与参考一致，创建持久工作区、切换并同步成员上下文', async ({ page }) => {
  const account = await register(page)
  const original = await selectedWorkspace(page)
  const dialog = await openWorkspaceDialog(page)
  const name = `菜单回归-${randomUUID().slice(0, 8)}`
  await dialog.getByLabel('工作区名称', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: '创建工作区', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toContainText(name)
  const created = await selectedWorkspace(page)
  expect(created.id).not.toBe(original.id)
  await page.reload()
  await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toContainText(name)
  const switcher = await openSwitcher(page)
  await expect(switcher).toContainText(account.email)
  await expect(switcher.getByRole('menuitem', { name, exact: true })).toHaveAttribute('aria-current', 'true')
  await expect(switcher.getByRole('menuitem', { name: '添加账户', exact: true })).toBeVisible()
  await expect(switcher.getByRole('menuitem', { name: /个人资料|偏好设置|切换明暗主题/ })).toHaveCount(0)
  await switcher.getByRole('menuitem', { name: original.name, exact: true }).click()
  await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toContainText(original.name)
  expect((await selectedWorkspace(page)).id).toBe(original.id)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '邀请和管理成员', exact: true }).click()
  const members = await page.request.get('/api/workspace')
  expect((await members.json()).workspace.id).toBe(original.id)
})

test('添加账户保留旧会话，可切回两个账户，退出后撤销全部设备会话', async ({ page, context }) => {
  const first = await register(page)
  const original = await selectedWorkspace(page)
  await context.clearCookies({ name: /_multi-/ })
  const switcher = await openSwitcher(page)
  await switcher.getByRole('menuitem', { name: '添加账户', exact: true }).click()
  await expect(page.getByRole('heading', { name: '添加账户', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '取消，返回当前账户', exact: true }).click()
  await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toBeVisible()
  expect((await selectedWorkspace(page)).id).toBe(original.id)
  await (await openSwitcher(page)).getByRole('menuitem', { name: '添加账户', exact: true }).click()
  await expect(page.getByRole('heading', { name: '添加账户', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '创建账号', exact: true }).last().click()
  await expect(page).toHaveURL(/addAccount=1/)
  const email = `second-${randomUUID()}@example.com`
  await page.getByLabel('称呼', { exact: true }).fill('第二个验证账户')
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(randomBytes(32).toString('base64url'))
  await page.getByRole('button', { name: '创建账号并进入', exact: true }).click()
  await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toContainText('第二个验证账户的工作区')
  await page.reload()
  const accounts = await openSwitcher(page)
  await expect(accounts).toContainText(first.email)
  await expect(accounts).toContainText(email)
  const multiCookies = (await context.cookies()).filter(cookie => cookie.name.includes('_multi-'))
  expect(multiCookies).toHaveLength(2)
  expect(multiCookies.every(cookie => cookie.httpOnly)).toBe(true)
  await accounts.getByRole('menuitem', { name: original.name, exact: true }).click()
  await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toContainText(original.name)
  await (await openSwitcher(page)).getByRole('menuitem', { name: '第二个验证账户的工作区', exact: true }).click()
  await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toContainText('第二个验证账户的工作区')
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/sign-in/)
  expect((await context.cookies()).filter(cookie => cookie.name.includes('_multi-'))).toHaveLength(0)
  await page.goto('/settings/members')
  await expect(page).toHaveURL(/\/sign-in/)
})

test('从工作区菜单粘贴真实邀请加入，并验证邮箱匹配', async ({ page, browser, baseURL }) => {
  await register(page, '/settings/members')
  const original = await selectedWorkspace(page)
  await page.getByRole('button', { name: '邀请成员', exact: true }).click()
  const invitation = page.getByRole('dialog', { name: '邀请成员', exact: true })
  const email = `join-menu-${randomUUID()}@example.com`
  await invitation.getByLabel('邮箱地址', { exact: true }).fill(email)
  await invitation.getByRole('button', { name: '创建邀请链接', exact: true }).click()
  const link = await invitation.getByLabel(`${email} 的邀请链接`, { exact: true }).inputValue()
  const memberContext = await browser.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
  const failures = watchRuntime(memberContext)
  try {
    const member = await memberContext.newPage()
    await register(member, '/', email)
    const own = await selectedWorkspace(member)
    const dialog = await openWorkspaceDialog(member)
    await dialog.getByRole('tab', { name: '加入工作区', exact: true }).click()
    await dialog.getByLabel('邀请链接', { exact: true }).fill(link)
    await dialog.getByRole('button', { name: '加入工作区', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect.poll(async () => (await selectedWorkspace(member)).id).toBe(original.id)
    expect(original.id).not.toBe(own.id)
    await member.reload()
    expect((await selectedWorkspace(member)).id).toBe(original.id)
    await page.reload()
    await expect(page.getByRole('row').filter({ hasText: email })).toBeVisible()
  } finally { await memberContext.close() }
  expect(failures).toEqual([])
})
