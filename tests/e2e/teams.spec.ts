import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { test, expect, register, registerInTeam, rail, browserClientHeaders, watchRuntime, app, BASE_PATH, seedTask, openIssueFromSearch } from './fixtures'

async function createTeam(page: Page, name: string, identifier: string) {
  await page.getByRole('button', { name: '新建团队', exact: true }).first().click()
  const form = page.getByRole('form', { name: '创建新团队', exact: true })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await form.getByLabel('团队名称', { exact: true }).fill(name)
  await form.getByLabel('团队标识', { exact: true }).fill(identifier)
  await form.getByRole('button', { name: '创建团队', exact: true }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await page.getByRole('link', { name: '全部团队', exact: true }).click()
  await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible()
}
async function createTask(page: Page, title: string, team?: string) {
  await seedTask(page, title)
  await page.reload()
  if (!team) return
  await openIssueFromSearch(page, title)
  const teamSelect = page.getByRole('combobox', { name: '团队', exact: true })
  await teamSelect.click()
  await page.getByRole('option', { name: team, exact: true }).click()
  const save = page.getByRole('button', { name: '保存团队归属', exact: true })
  // Saving an explicit local target does not ask for another approval.
  const unexpectedDialog = (dialog: import('@playwright/test').Dialog) => { void dialog.dismiss(); throw new Error('Unexpected task-team confirmation') }
  page.on('dialog', unexpectedDialog)
  await save.click()
  await expect(save).toHaveCount(0)
  page.off('dialog', unexpectedDialog)
  await expect(teamSelect).toContainText(team)
  // Team assignment keeps personal scope; these collaboration fixtures explicitly publish.
  await page.getByRole('button', { name: '归属：个人', exact: true }).click()
  await page.getByRole('menuitem', { name: '工作区', exact: true }).click()
  await expect(page.getByRole('button', { name: '归属：工作区', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
}
async function showAllTasks(page: Page) {
  await rail(page, '看板').click()
  // The board mounts after the section switch settles; check its filters only once it is there.
  await expect(page.getByRole('region', { name: '任务看板', exact: true })).toBeVisible()
  // The board opens filtered to 负责人 = 我; teammates' public tasks need it off.
  const clear = page.getByRole('button', { name: '移除负责人筛选', exact: true })
  await expect(async () => {
    if (await clear.isVisible()) await clear.click({ timeout: 1000 })
    await expect(clear).toHaveCount(0, { timeout: 1000 })
  }).toPass()
}
function boardCard(page: Page, title: string) {
  return page.getByRole('region', { name: '任务看板', exact: true }).getByRole('group', { name: title, exact: true })
}

test('公开团队创建、搜索、编辑、负责人保护、任务归属和项目多团队关联', async ({ page }) => {
  test.setTimeout(180000)
  await registerInTeam(page, '/settings/teams')
  await createTeam(page, '产品团队', 'PRODUCT')
  await createTeam(page, '工程团队', 'ENGINEER')
  await page.getByRole('textbox', { name: '搜索团队', exact: true }).fill('PRODUCT')
  await expect(page.getByRole('row').filter({ hasText: '工程团队' })).toHaveCount(0)
  const team = page.getByRole('row').filter({ hasText: '产品团队' })
  await team.getByRole('button', { name: '产品团队 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).hover()
  await page.getByRole('menuitem', { name: '常规', exact: true }).click()
  const editor = page.getByRole('form', { name: '团队常规设置', exact: true })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await editor.getByLabel('团队简介', { exact: true }).fill('共同负责产品交付')
  await editor.getByRole('button', { name: '保存更改', exact: true }).click()
  await page.getByRole('link', { name: '全部团队', exact: true }).click()
  await expect(team).toContainText('共同负责产品交付')
  await team.getByRole('button', { name: '产品团队 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).hover()
  await page.getByRole('menuitem', { name: '成员', exact: true }).click()
  const roster = page.getByRole('region', { name: '产品团队 · 团队成员', exact: true })
  await roster.getByRole('button', { name: /^设为成员：/ }).click()
  await expect(roster.getByRole('alert')).toContainText('至少一位')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await rail(page, '主页').click()
  const privateTitle = `历史私有任务 ${randomUUID()}`
  const publicTitle = `公开任务 ${randomUUID()}`
  await createTask(page, privateTitle)
  await createTask(page, publicTitle, 'PRODUCT · 产品团队')
  await showAllTasks(page)
  await boardCard(page, publicTitle).click()
  // Detail page renders a Base UI Select: open the trigger and check the selected option.
  const teamSelect = page.getByRole('combobox', { name: '团队', exact: true })
  await expect(teamSelect).toContainText('PRODUCT · 产品团队')
  await teamSelect.click()
  await expect(page.getByRole('option', { name: 'PRODUCT · 产品团队', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
  // Nav v3 keeps projects out of the left column; they stay reachable by link.
  await page.goto(app('/?section=projects'))
  await page.getByRole('button', { name: '新建项目', exact: true }).first().click()
  const projectDialog = page.getByRole('dialog', { name: '新建项目', exact: true })
  await projectDialog.getByLabel('项目名称', { exact: true }).fill('跨团队交付项目')
  await projectDialog.getByLabel('主责团队', { exact: true }).selectOption({ label: 'PRODUCT · 产品团队' })
  await projectDialog.getByRole('button', { name: '创建项目', exact: true }).click()
  await expect(projectDialog).not.toBeVisible()
  await page.getByRole('button', { name: '管理关联团队', exact: true }).click()
  const relation = page.getByRole('dialog', { name: '项目关联团队', exact: true })
  await relation.getByRole('checkbox', { name: 'ENGINEER · 工程团队', exact: true }).check()
  await relation.getByLabel('主责团队', { exact: true }).selectOption({ label: '工程团队' })
  page.once('dialog', dialog => dialog.accept())
  await relation.getByRole('button', { name: '保存团队关联', exact: true }).click()
  await expect(relation).not.toBeVisible()
  await expect(page.getByText('工程团队 · 主责', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: /^任务/ }).click()
  await page.getByRole('button', { name: '关联任务', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '关联项目任务', exact: true })
  await picker.getByRole('checkbox', { name: privateTitle, exact: false }).check()
  await picker.getByRole('button', { name: '保存关联', exact: true }).click()
  await expect(picker.getByRole('alert')).toContainText('公开项目只能关联')
  await picker.getByRole('checkbox', { name: privateTitle, exact: false }).uncheck()
  await picker.getByRole('checkbox', { name: publicTitle, exact: false }).check()
  await picker.getByRole('button', { name: '保存关联', exact: true }).click()
  await expect(picker).not.toBeVisible()
  await expect(page.locator('[aria-label="任务列表"]').getByText(publicTitle, { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '跨团队交付项目', exact: true }).click()
  await expect(page.getByText('工程团队 · 主责', { exact: true })).toBeVisible()
})

test('公开范围限于工作区，未加入团队可访问，停用成员后撤销访问', async ({ page, browser, baseURL }) => {
  test.setTimeout(180000)
  await registerInTeam(page, '/settings/teams')
  await createTeam(page, '共享团队', 'SHARED')
  await rail(page, '主页').click()
  const publicTitle = `工作区公开 ${randomUUID()}`
  const privateTitle = `个人保密 ${randomUUID()}`
  await createTask(page, publicTitle, 'SHARED · 共享团队')
  await createTask(page, privateTitle)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '成员', exact: true }).click()
  await page.getByRole('button', { name: '邀请成员', exact: true }).click()
  const invitation = page.getByRole('dialog', { name: '邀请成员', exact: true })
  const email = `team-member-${randomUUID()}@example.com`
  await invitation.getByLabel('邮箱地址', { exact: true }).fill(email)
  await invitation.getByRole('button', { name: '创建邀请链接', exact: true }).click()
  const inviteUrl = new URL(await invitation.getByLabel(`${email} 的邀请链接`, { exact: true }).inputValue()).pathname
    const invitePath = inviteUrl.startsWith(BASE_PATH) ? inviteUrl.slice(BASE_PATH.length) || '/' : inviteUrl
  await invitation.getByRole('button', { name: '完成', exact: true }).click()
  const memberContext = await browser.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
  const workspaceId = (await (await page.request.get(app('/api/workspace'))).json()).workspace.id as string
  // Expected denials once the member leaves; allowed per test, any number of refetches.
  const runtime = watchRuntime(memberContext, [], ['/api/workspace', '/api/teams/directory'].map(path => ({ path: app(`${path}?workspace=${workspaceId}`), message: 'Failed to load resource: the server responded with a status of 403 (Forbidden)' })))
  try {
    const member = await memberContext.newPage()
    await register(member, invitePath, email)
    await member.getByRole('button', { name: '接受邀请并加入', exact: true }).click()
    await expect(member).toHaveURL(/\/settings\/members\?workspace=/)
    expect(new URL(member.url()).searchParams.get('workspace')).toBe(workspaceId)
    await member.goto(app('/settings/teams'))
    const row = member.getByRole('row').filter({ hasText: '共享团队' })
    await row.getByRole('button', { name: '共享团队 的操作', exact: true }).click()
    await member.getByRole('menuitem', { name: '加入团队', exact: true }).click()
    await row.getByRole('button', { name: '共享团队 的操作', exact: true }).click()
    await expect(member.getByRole('menuitem', { name: '退出团队…', exact: true })).toBeVisible()
    await member.getByRole('menuitem', { name: '退出团队…', exact: true }).click()
    await row.getByRole('button', { name: '共享团队 的操作', exact: true }).click()
    await expect(member.getByRole('menuitem', { name: '加入团队', exact: true })).toBeVisible()
    await member.keyboard.press('Escape')
    await member.goto(app('/'))
    await showAllTasks(member)
    await expect(boardCard(member, publicTitle)).toBeVisible()
    await expect(member.getByText(privateTitle, { exact: true })).toHaveCount(0)
    await page.goto(app(`/settings/members?workspace=${workspaceId}`))
    const membership = page.getByRole('row').filter({ hasText: email })
    await membership.getByRole('button', { name: /^管理 / }).click()
    await page.getByRole('menuitem', { name: '停用成员', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '确认更新', exact: true }).click()
    await expect(page.getByRole('alertdialog')).not.toBeVisible()
    await member.reload()
    await showAllTasks(member)
    await expect(member.getByText(publicTitle, { exact: true })).toHaveCount(0)
    await member.goto(app(`/settings/teams?workspace=${workspaceId}`))
    await expect(member.getByRole('alert').filter({ hasText: '成员资格已被停用' })).toBeVisible()
  } finally {
    await memberContext.close()
    expect(runtime).toEqual([])
  }
})

test('非创建者成员在他人公开任务上改父子关系，关系区与选择器立即刷新', async ({ page, browser, baseURL }) => {
  test.setTimeout(180000)
  await registerInTeam(page, '/settings/teams')
  await createTeam(page, '协作团队', 'COLLAB')
  await rail(page, '主页').click()
  const parentTitle = `他人父任务 ${randomUUID()}`
  const childTitle = `他人子任务 ${randomUUID()}`
  await createTask(page, parentTitle, 'COLLAB · 协作团队')
  await createTask(page, childTitle, 'COLLAB · 协作团队')
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '成员', exact: true }).click()
  await page.getByRole('button', { name: '邀请成员', exact: true }).click()
  const invitation = page.getByRole('dialog', { name: '邀请成员', exact: true })
  const email = `relation-member-${randomUUID()}@example.com`
  await invitation.getByLabel('邮箱地址', { exact: true }).fill(email)
  await invitation.getByRole('button', { name: '创建邀请链接', exact: true }).click()
  const inviteUrl = new URL(await invitation.getByLabel(`${email} 的邀请链接`, { exact: true }).inputValue()).pathname
  const invitePath = inviteUrl.startsWith(BASE_PATH) ? inviteUrl.slice(BASE_PATH.length) || '/' : inviteUrl
  await invitation.getByRole('button', { name: '完成', exact: true }).click()
  const memberContext = await browser.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
  try {
    const member = await memberContext.newPage()
    await register(member, invitePath, email)
    await member.getByRole('button', { name: '接受邀请并加入', exact: true }).click()
    await expect(member).toHaveURL(/\/settings\/members\?workspace=/)
    // Relation edits by a non-owner require issue membership on both tasks; the owner adds it.
    await page.goto(app('/'))
    await showAllTasks(page)
    for (const title of [parentTitle, childTitle]) {
      await boardCard(page, title).click()
      await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title)
      await page.getByRole('button', { name: '更多任务操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '管理协作成员…', exact: true }).click()
      await page.getByPlaceholder('输入对方的注册邮箱', { exact: true }).fill(email)
      await page.getByRole('button', { name: '添加成员', exact: true }).click()
      await expect(page.getByText('成员已添加，对方登录后可在「协作任务」中访问此任务。', { exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
    }
    await member.goto(app('/'))
    await showAllTasks(member)
    await boardCard(member, parentTitle).click()
    await expect(member.getByLabel('任务标题', { exact: true })).toHaveValue(parentTitle)
    // Non-owners cannot delete (owner-only menu item), so delete/undo is covered by the owner flow only.
    await member.getByRole('button', { name: '更多任务操作', exact: true }).click()
    const actions = member.getByRole('menu')
    await expect(actions).toBeVisible()
    await expect(member.getByRole('menuitem', { name: /^删除任务/ })).toHaveCount(0)
    await member.keyboard.press('Escape')
    // The closing menu keeps an inert backdrop over the page until it is gone.
    await expect(actions).toHaveCount(0)
    const children = member.getByRole('region', { name: '子任务', exact: true })
    // Empty sub-tasks show only 添加子任务 (R-40); 添加现有子任务 is in the ⋯ menu either way.
    const addExisting = async () => {
      await member.getByRole('button', { name: '更多任务操作', exact: true }).click()
      await member.getByRole('menuitem', { name: '添加现有子任务…', exact: true }).click()
      return member.getByRole('dialog', { name: '添加现有子任务', exact: true })
    }
    let picker = await addExisting()
    await picker.getByRole('combobox', { name: '搜索关联任务', exact: true }).fill(childTitle)
    await picker.getByRole('option').filter({ hasText: childTitle }).click()
    await expect(picker).not.toBeVisible()
    await expect(children.getByRole('button', { name: '子任务 0 / 1', exact: true })).toBeVisible()
    await children.getByRole('button', { name: `移除子任务关系：${childTitle}`, exact: true }).click()
    await expect(children.getByRole('button', { name: '添加子任务', exact: true })).toBeVisible()
    // Hold the picker's search: it must show loading or fresh data, never results from before the unlink.
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let heldActions = 0
    const search = /\/api\/issues\/search\?/
    await member.route(search, async route => { heldActions++; await held; await route.fallback() })
    picker = await addExisting()
    await expect.poll(() => heldActions).toBeGreaterThan(0)
    await expect(picker.getByText('正在读取任务…', { exact: true }).or(picker.getByRole('option').filter({ hasText: childTitle }))).toBeVisible()
    release()
    await member.unroute(search)
    await expect(picker.getByRole('option').filter({ hasText: childTitle })).toBeVisible()
    await picker.getByRole('button', { name: '关闭', exact: true }).click()
  } finally {
    await memberContext.close()
  }
})
