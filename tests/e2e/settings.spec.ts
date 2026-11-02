import { randomUUID } from 'node:crypto'
import type { BrowserContext, Page } from '@playwright/test'
import { test, expect, register, registerInTeam, rail, app, expectItems, browserClientHeaders, BASE_PATH } from './fixtures'

test('从工作台打开设置不等待 RSC，成员读取未完成时仍可立即切走', async ({ page }) => {
  const navigations: string[] = []
  let releaseRead!: () => void
  let readingMembers = false
  const waitingForData = new Promise<void>(resolve => { releaseRead = resolve })
  await page.route('**/api/workspace*', async route => {
    readingMembers = true
    await waitingForData
    await route.continue()
  })
  await registerInTeam(page)
  // The conversation list is an in-flow sidebar (collapsible="none"), not the offcanvas container.
  const workspaceSidebar = page.locator('[data-slot="sidebar"]')
  await expect(workspaceSidebar.getByRole('button', { name: '新建 Bot', exact: true })).toBeVisible()
  await expect(workspaceSidebar.getByRole('link', { name: '浏览与管理团队', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toBeEnabled()
  await page.route('**/*', route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && (request.headers().rsc === '1' || url.searchParams.has('_rsc'))) {
      navigations.push(url.href)
      return route.abort()
    }
    return route.fallback()
  })
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await expect(page.getByRole('group', { name: '界面主题', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toHaveCount(1)
  // Workspaces switch only in the avatar menu; the settings column has no switcher (R-75).
  await expect(page.locator('[data-slot="settings-list"]').getByRole('button', { name: /切换工作区|工作区菜单/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '账户菜单', exact: true })).toHaveCount(0)
  await expect(page.locator('[data-slot="sidebar-footer"]')).toHaveCount(0)
  const sidebar = page.locator('[data-slot="settings-list"]')
  await sidebar.getByRole('link', { name: '账户', exact: true }).click()
  await expect(page.getByRole('heading', { name: '账户', exact: true })).toBeVisible()
  await sidebar.getByRole('link', { name: '成员', exact: true }).click()
  await expect.poll(() => readingMembers).toBe(true)
  await expect(page.getByRole('heading', { name: '成员', exact: true })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: '成员', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('status', { name: '正在读取成员', exact: true })).toBeVisible()
  await sidebar.getByRole('link', { name: '账户', exact: true }).click()
  await expect(page.getByRole('heading', { name: '账户', exact: true })).toBeVisible()
  releaseRead()
  await sidebar.getByRole('link', { name: '成员', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '搜索成员或邀请', exact: true })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '回归测试成员' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '当前工作区', exact: true })).toHaveCount(0)
  await sidebar.getByRole('link', { name: '团队', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '搜索团队', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '团队目录工作区', exact: true })).toHaveCount(0)
  await sidebar.getByRole('link', { name: '成员', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '搜索成员或邀请', exact: true })).toBeVisible()
  await rail(page, '主页').click()
  await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toBeVisible()
  expect(navigations).toEqual([])
  await page.goBack()
  await expect(page.getByRole('textbox', { name: '搜索成员或邀请', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('textbox', { name: '搜索成员或邀请', exact: true })).toBeVisible()
})

test.describe('工作区访问拒绝', () => {
  // The test denies this workspace on purpose; how often the page refetches it is not the contract.
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture functions require destructured arguments.
  test.use({ allowedConsoleErrors: async ({}, use) => { await use(['/api/workspace', '/api/teams/directory'].map(path => ({ path: app(`${path}?workspace=00000000-0000-4000-8000-000000000099`), message: 'Failed to load resource: the server responded with a status of 403 (Forbidden)' }))) } })

test('工作区数据等待和拒绝访问时不泄漏上一工作区内容', async ({ page }) => {
  await registerInTeam(page, '/settings/members')
  await expect(page.getByRole('row').filter({ hasText: '回归测试成员' })).toBeVisible()
  await page.route('**/api/workspace?workspace=00000000-0000-4000-8000-000000000099', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: '没有查看此工作区的权限。' }) }))
  await page.route('**/api/teams/directory?workspace=00000000-0000-4000-8000-000000000099', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: '没有查看此工作区的权限。' }) }))
  await page.evaluate(path => window.history.pushState(null, '', path), app('/settings/members?workspace=00000000-0000-4000-8000-000000000099'))
  await expect(page.getByRole('alert').filter({ hasText: '没有查看此工作区的权限。' })).toContainText('没有查看此工作区的权限。')
  await expect(page.getByRole('row').filter({ hasText: '回归测试成员' })).toHaveCount(0)
  await page.goBack()
  await expect(page.getByRole('row').filter({ hasText: '回归测试成员' })).toBeVisible()
})
})

test('默认工作区解析后改用带 workspace 的读取时，管理员分区不闪掉', async ({ page }) => {
  // Settings first read the default workspace, then name it once the team directory resolves it.
  // Slow both, so the unnamed read lands first and the named one stays pending for a while:
  // the admin-only rows must not drop out meanwhile, or the sidebar jumps.
  await page.route('**/api/teams/directory*', async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.fallback() })
  await page.route('**/api/workspace?workspace=*', async route => { await new Promise(resolve => setTimeout(resolve, 2000)); await route.fallback() })
  // 团队权限 and 成员 exist only in a team workspace; a new account's own workspace is personal.
  await registerInTeam(page, '/settings/members')
  const admin = page.locator('[data-slot="settings-list"]').getByRole('link', { name: '团队权限', exact: true })
  await expect(admin).toBeVisible()
  const gaps: number[] = []
  for (const started = Date.now(); Date.now() - started < 4000;) {
    if (await admin.count() === 0) gaps.push(Date.now() - started)
    await page.waitForTimeout(50)
  }
  expect(gaps, '管理员分区在读取期间消失').toEqual([])
})

test('设置页打开并空闲后，每个分区首次打开都不显示骨架屏', async ({ page }) => {
  test.setTimeout(120000)
  // A team workspace, so every section (members, permissions, audit) is there to open.
  await registerInTeam(page, '/settings?section=preferences')
  const sidebar = page.locator('[data-slot="settings-list"]')
  await expect(sidebar.getByRole('link', { name: '计费', exact: true })).toBeVisible()
  // Settings loads every section's data once it is idle; after that nothing is left to wait for.
  await page.waitForLoadState('networkidle')
  const skeleton = page.locator('main [data-slot="skeleton"]')
  const flashed: string[] = []
  const names = (await sidebar.locator('[data-slot="sidebar-group"]').filter({ hasText: /账号|E2E 团队/ }).getByRole('link').allInnerTexts()).map(name => name.trim())
  expect(names.length).toBeGreaterThan(10)
  for (const name of names) {
    const link = sidebar.getByRole('link', { name, exact: true })
    await link.click()
    await expect(link).toHaveAttribute('aria-current', 'page')
    for (const deadline = Date.now() + 400; Date.now() < deadline;) {
      if (await skeleton.count()) { flashed.push(name); break }
      await page.waitForTimeout(20)
    }
  }
  expect(flashed, '这些分区仍显示了骨架屏').toEqual([])
})

test('设置读取接口沿用原来的权限：仅管理员可读的只给管理员，外人只得到错误', async ({ page, browser, baseURL }) => {
  test.setTimeout(120000)
  await registerInTeam(page, '/settings/members')
  await page.getByRole('button', { name: '邀请成员', exact: true }).click()
  const invite = page.getByRole('dialog', { name: '邀请成员', exact: true })
  const email = `member-${randomUUID()}@example.com`
  await invite.getByLabel('邮箱地址', { exact: true }).fill(email)
  await invite.getByRole('button', { name: '创建邀请链接', exact: true }).click()
  const inviteURL = new URL(await invite.getByLabel(`${email} 的邀请链接`, { exact: true }).inputValue())
  await invite.getByRole('button', { name: '完成', exact: true }).click()
  const workspace = (await (await page.request.get(app('/api/workspace'))).json()).workspace.id as string

  const memberContext = await browser.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
  const outsiderContext = await browser.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
  const anonymous = await browser.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
  try {
    const member = await memberContext.newPage()
    await register(member, inviteURL.pathname.slice(BASE_PATH.length), email)
    await member.getByRole('button', { name: '接受邀请并加入', exact: true }).click()
    await expect(member).toHaveURL(/\/settings\/members\?workspace=/)
    const outsider = await outsiderContext.newPage()
    await register(outsider)

    const read = async (context: BrowserContext, name: string) => {
      const response = await context.request.get(app(`/api/settings/${name}?workspace=${workspace}`))
      expect(response.headers()['cache-control']).toBe('private, no-store')
      return { status: response.status(), body: await response.json() as { error?: string; canEdit?: boolean; secrets?: Record<string, unknown>[] } | null }
    }
    // Admin-only, as the actions were: 审计日志 and 计费.
    for (const name of ['audit', 'billing']) {
      const owner = await read(page.context(), name)
      expect(owner.status, name).toBe(200)
      expect(owner.body?.error, `管理员读取 ${name}`).toBeUndefined()
      expect((await read(memberContext, name)).body?.error, `成员读取 ${name}`).toBeTruthy()
    }
    // Members read these, as before: secret names without values, and app policy without edit rights.
    const memberSecrets = await read(memberContext, 'secrets')
    expect(memberSecrets.body?.error).toBeUndefined()
    expect(memberSecrets.body?.secrets?.every(secret => !('value' in secret))).toBe(true)
    expect((await read(memberContext, 'app-policy')).body?.canEdit).toBe(false)
    expect((await read(page.context(), 'app-policy')).body?.canEdit).toBe(true)
    for (const name of ['audit', 'billing', 'secrets', 'app-policy', 'workspace-general', 'usage']) {
      expect((await read(outsiderContext, name)).body?.error, `外人读取 ${name}`).toBeTruthy()
      const signedOut = await read(anonymous, name)
      expect(signedOut.status === 401 || Boolean(signedOut.body?.error), `未登录读取 ${name}`).toBe(true)
    }
    expect((await page.request.get(app('/api/settings/unknown'))).status()).toBe(404)
  } finally {
    await memberContext.close()
    await outsiderContext.close()
    await anonymous.close()
  }
})

test('悬停预取后首次打开与再次打开设置分区都不显示骨架屏', async ({ page }) => {
  await registerInTeam(page, '/settings?section=preferences')
  const sidebar = page.locator('[data-slot="settings-list"]')
  const skeleton = page.locator('main [data-slot="skeleton"]')
  let sawSkeleton = false
  const watch = async (name: string) => {
    await expect.poll(async () => {
      if (await skeleton.count()) sawSkeleton = true
      return await page.getByRole('heading', { level: 1, name, exact: true }).count() > 0 && await skeleton.count() === 0
    }, { intervals: [10] }).toBe(true)
  }
  for (const name of ['安全', '通知', '常规', '密钥与环境']) {
    const link = sidebar.getByRole('link', { name, exact: true })
    await link.hover()
    // The hover starts the section's reads; once they return, the click has nothing to wait for.
    await page.waitForLoadState('networkidle')
    await link.click()
    await watch(name)
  }
  expect(sawSkeleton, '悬停后首次打开不应出现骨架屏').toBe(false)
  for (const name of ['安全', '通知', '常规', '密钥与环境']) {
    await sidebar.getByRole('link', { name, exact: true }).click()
    await watch(name)
  }
  expect(sawSkeleton, '再次打开不应出现骨架屏').toBe(false)
})

test('个人设置切换不请求服务端，并保持 URL、历史记录与跨页导航一致', async ({ page }) => {
  await registerInTeam(page, '/settings?section=preferences')
  const sidebar = page.locator('[data-slot="settings-list"]')
  await expect(page.getByRole('button', { name: '浅色', exact: true })).toBeEnabled()
  const serverNavigations: string[] = []
  await page.route('**/settings?**', route => {
    const url = new URL(route.request().url())
    if (url.pathname === app('/settings') && url.searchParams.has('_rsc')) {
      serverNavigations.push(url.href)
      return route.abort()
    }
    return route.continue()
  })
  await sidebar.getByRole('link', { name: '账户', exact: true }).click()
  await expect(page.getByRole('heading', { name: '账户', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/section=account/)
  await expect(sidebar.getByRole('link', { name: '账户', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1)
  await sidebar.getByRole('link', { name: '常规', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: '常规', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/section=general/)
  await page.goBack()
  await expect(page.getByRole('heading', { name: '账户', exact: true })).toBeVisible()
  await page.goForward()
  await expect(page.getByRole('heading', { level: 1, name: '常规', exact: true })).toBeVisible()
  await sidebar.getByRole('link', { name: '偏好设置', exact: true }).click()
  await expect(page.getByRole('group', { name: '界面主题', exact: true })).toBeVisible()
  expect(serverNavigations).toEqual([])
  await page.unroute('**/settings?**')
  await sidebar.getByRole('link', { name: '账户', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('heading', { name: '账户', exact: true })).toBeVisible()
  await sidebar.getByRole('link', { name: '团队', exact: true }).click()
  await expect(page.getByRole('heading', { name: '团队', exact: true })).toBeVisible()
  await sidebar.getByRole('link', { name: '偏好设置', exact: true }).click()
  await expect(page.getByRole('group', { name: '界面主题', exact: true })).toBeVisible()
  await sidebar.getByRole('link', { name: '账户', exact: true }).click()
  await expect(page.getByRole('heading', { name: '账户', exact: true })).toBeVisible()
})

test('团队子页切换复用目录，历史记录和刷新可恢复当前视图', async ({ page }) => {
  await registerInTeam(page, '/settings/teams')
  await page.getByRole('button', { name: '新建团队', exact: true }).first().click()
  const form = page.getByRole('form', { name: '创建新团队', exact: true })
  await form.getByLabel('团队名称', { exact: true }).fill('导航性能团队')
  await form.getByLabel('团队标识', { exact: true }).fill('NAVPERF')
  await form.getByRole('button', { name: '创建团队', exact: true }).click()
  await expect(page.getByRole('heading', { name: '导航性能团队', exact: true })).toBeVisible()
  const navigations: string[] = []
  await page.route('**/settings/teams?**', route => {
    if (route.request().headers().rsc === '1') { navigations.push(route.request().url()); return route.abort() }
    return route.continue()
  })
  const options = page.getByRole('region', { name: '团队设置选项', exact: true })
  await options.getByRole('link', { name: '常规设置', exact: true }).click()
  await expect(page.getByRole('form', { name: '团队常规设置', exact: true })).toBeVisible()
  await page.goBack()
  await expect(options).toBeVisible()
  await options.getByRole('link', { name: '成员', exact: true }).click()
  await expect(page.getByRole('heading', { name: '团队成员', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '导航性能团队 · 团队成员', exact: true }).getByRole('row').filter({ hasText: '回归测试成员' })).toBeVisible()
  await page.getByRole('link', { name: '团队设置', exact: true }).click()
  await page.getByRole('link', { name: '全部团队', exact: true }).click()
  await expect(page.getByRole('heading', { name: '团队', exact: true })).toBeVisible()
  await page.getByRole('row').filter({ hasText: '导航性能团队' }).getByRole('button', { name: '导航性能团队 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).hover()
  await page.getByRole('menuitem', { name: '常规', exact: true }).click()
  await expect(page).toHaveURL(/view=general/)
  expect(navigations).toEqual([])
  await page.unroute('**/settings/teams?**')
  await page.reload()
  await expect(page.getByRole('form', { name: '团队常规设置', exact: true }).getByLabel('团队标识', { exact: true })).toHaveValue('NAVPERF')
})

test('成员首屏使用服务端结果，不立即重复读取成员 API', async ({ page }) => {
  const reads: string[] = []
  // Members are a team workspace's; count reads from the members page's own first load.
  await registerInTeam(page)
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/workspace') reads.push(request.url()) })
  await page.goto(app('/settings/members'))
  await expect(page.getByRole('button', { name: '邀请成员', exact: true })).toBeEnabled()
  await page.getByRole('textbox', { name: '搜索成员或邀请', exact: true }).fill('回归测试成员')
  await expect(page.getByRole('row').filter({ hasText: '回归测试成员' })).toBeVisible()
  expect(reads).toEqual([])
  await page.reload()
  await expect(page.getByRole('row').filter({ hasText: '回归测试成员' })).toBeVisible()
  expect(reads).toEqual([])
})

test('团队创建、常规设置与成员管理都在同一设置页内完成', async ({ page }, testInfo) => {
  await registerInTeam(page, '/settings/teams')
  const sidebar = page.locator('[data-slot="settings-list"]')
  await expect(sidebar).toHaveCount(1)
  await expect(page.getByRole('main')).toHaveCount(1)
  await sidebar.getByRole('link', { name: '成员', exact: true }).click()
  await expect(page.getByRole('heading', { name: '成员', exact: true })).toBeVisible()
  await sidebar.getByRole('link', { name: '偏好设置', exact: true }).click()
  await expect(page.getByRole('group', { name: '界面主题', exact: true })).toBeVisible()
  const preferenceTitleStyle = await page.getByText('界面主题', { exact: true }).evaluate(element => {
    const style = getComputedStyle(element)
    return { color: style.color, weight: style.fontWeight, size: style.fontSize, leading: style.lineHeight }
  })
  const preferenceCard = page.locator('[data-settings-card]').first()
  const preferenceCardBounds = await preferenceCard.boundingBox()
  const preferenceCardBackground = await preferenceCard.evaluate(element => getComputedStyle(element).backgroundColor)
  await sidebar.getByRole('link', { name: '团队', exact: true }).click()
  await page.getByRole('button', { name: '新建团队', exact: true }).first().click()
  const form = page.getByRole('form', { name: '创建新团队', exact: true })
  await expect(form).toBeVisible()
  const nameLabel = form.locator('label[for="team-name"]')
  const identifierLabel = form.locator('label[for="team-identifier"]')
  await expect(nameLabel).toBeVisible()
  await expect(identifierLabel).toBeVisible()
  await expect(nameLabel).toHaveCSS('font-weight', '500')
  await expect(identifierLabel).toHaveCSS('font-weight', '500')
  for (const label of [nameLabel, identifierLabel]) {
    await expect(label).toHaveCSS('color', preferenceTitleStyle.color)
    await expect(label).toHaveCSS('font-size', preferenceTitleStyle.size)
    await expect(label).toHaveCSS('font-weight', preferenceTitleStyle.weight)
    await expect(label).toHaveCSS('line-height', preferenceTitleStyle.leading)
  }
  const teamCard = form.locator('[data-slot="field-group"]')
  await expect(teamCard).toHaveCSS('background-color', preferenceCardBackground)
  const teamCardBounds = await teamCard.boundingBox()
  const headingBounds = await page.getByRole('heading', { name: '创建新团队', exact: true }).boundingBox()
  expect(teamCardBounds!.x).toBe(preferenceCardBounds!.x)
  expect(teamCardBounds!.width).toBe(preferenceCardBounds!.width)
  expect(headingBounds!.x).toBe(teamCardBounds!.x)
  const rows = form.locator('[data-slot="field"]')
  for (let index = 0; index < await rows.count(); index++) {
    const row = rows.nth(index)
    const content = await row.locator('[data-slot="field-content"]').boundingBox()
    const control = await row.locator('[data-slot="settings-control"]').boundingBox()
    expect(Math.abs(content!.y + content!.height / 2 - control!.y - control!.height / 2)).toBeLessThan(1)
  }
  const descriptionColor = await form.locator('[data-slot="field-description"]').first().evaluate(element => getComputedStyle(element).color)
  expect(await nameLabel.evaluate(element => getComputedStyle(element).color)).not.toBe(descriptionColor)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(sidebar).toHaveCount(1)
  await page.reload()
  await expect(form).toBeVisible()
  const teamName = form.getByLabel('团队名称', { exact: true })
  const teamIdentifier = form.getByLabel('团队标识', { exact: true })
  await teamName.fill('Engineering')
  await expect(teamIdentifier).toHaveValue('ENG')
  await teamIdentifier.fill('CUSTOM')
  await teamName.fill('Product Engineering')
  await expect(teamIdentifier).toHaveValue('CUSTOM')
  await teamIdentifier.press('ControlOrMeta+A')
  await teamIdentifier.press('Backspace')
  await expect(teamIdentifier).toHaveValue('PE')
  await teamName.fill('设置回归团队')
  await teamIdentifier.fill('SETTINGS')
  await testInfo.attach('页内创建团队', { body: await page.screenshot({ path: '/tmp/agent-browser/team-create-inline.png', fullPage: true }), contentType: 'image/png' })
  await form.getByRole('button', { name: '创建团队', exact: true }).click()
  await expect(page.getByRole('heading', { name: '设置回归团队', exact: true })).toBeVisible()
  await expect(form).not.toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: '设置回归团队', exact: true })).toHaveAttribute('aria-current', 'page')
  // Two groups: 账号, and the current workspace by name (decision 2026-10-31-2130).
  await expectItems(sidebar.locator('[data-slot="sidebar-group-label"]'), ['账号', 'E2E 团队', '你的团队'])
  const administration = sidebar.locator('[data-slot="sidebar-group"]').filter({ has: page.locator('[data-slot="sidebar-group-label"]', { hasText: /^E2E 团队$/ }) })
  await expectItems(administration.locator('[data-slot="sidebar-menu-button"]'), ['常规', '成员', '团队', 'Bot 与 Agents', '团队权限', '密钥与环境', '审计日志', '用量', '计费'])
  await expect(sidebar.locator('[data-slot="sidebar-menu-sub"]')).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: '团队常规设置', exact: true })).toHaveCount(0)
  const settings = page.getByRole('region', { name: '团队设置选项', exact: true })
  await expect(settings.getByLabel('1 位成员', { exact: true })).toBeVisible()
  await expectItems(page.getByRole('heading', { level: 2 }), ['任务、项目和文档', '工作流', 'AI 与 Bot', '团队层级', '危险操作'])
  await expect(page.getByText('Slack 通知', { exact: true })).toBeVisible()
  await expect(page.getByText('任务状态', { exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: '退出团队', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: '确认退出', exact: true }).click()
  await expect(confirmation.getByRole('alert')).toContainText('团队须保留至少一位启用中的负责人')
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(confirmation).not.toBeVisible()
  await settings.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight))
  await testInfo.attach('团队设置总览', { body: await page.screenshot({ path: '/tmp/agent-browser/team-settings-overview.png', fullPage: true }), contentType: 'image/png' })
  await settings.getByRole('link', { name: /常规设置/ }).click()
  const general = page.getByRole('form', { name: '团队常规设置', exact: true })
  await expect(general.getByLabel('团队标识', { exact: true })).toHaveValue('SETTINGS')
  await general.getByLabel('团队简介', { exact: true }).fill('主页、设置与团队创建共享导航体系。')
  await general.getByRole('button', { name: '保存更改', exact: true }).click()
  await expect(settings).toBeVisible()
  await settings.getByRole('link', { name: /成员/ }).click()
  await expect(page.getByRole('heading', { name: '团队成员', exact: true })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '负责人' })).toContainText('回归测试成员')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('link', { name: '团队设置', exact: true }).click()
  await page.getByRole('link', { name: '团队概览', exact: true }).click()
  await expect(page.getByRole('heading', { name: '设置回归团队', exact: true })).toBeVisible()
  await expect(page.getByText('主页、设置与团队创建共享导航体系。', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: '团队设置', exact: true }).click()
  await page.reload()
  await expect(settings).toBeVisible()
  await sidebar.getByRole('link', { name: '创建团队', exact: true }).click()
  await expect(form).toBeVisible()
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page).not.toHaveURL(/create=1/)
  await sidebar.getByRole('link', { name: '创建团队', exact: true }).click()
  await expect(form).toBeVisible()
})

test('移动端页内创建不横向溢出，返回和侧栏切换保护未保存内容', async ({ page }) => {
  await registerInTeam(page, '/settings/teams')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '新建团队', exact: true }).first().click()
  const form = page.getByRole('form', { name: '创建新团队', exact: true, includeHidden: true })
  await expect(form).toBeVisible()
  const nameLabel = form.locator('label[for="team-name"]')
  const identifierLabel = form.locator('label[for="team-identifier"]')
  await expect(nameLabel).toBeVisible()
  await expect(identifierLabel).toBeVisible()
  await expect(nameLabel).toHaveCSS('font-weight', '500')
  await expect(identifierLabel).toHaveCSS('font-weight', '500')
  const descriptionColor = await form.locator('[data-slot="field-description"]').first().evaluate(element => getComputedStyle(element).color)
  expect(await nameLabel.evaluate(element => getComputedStyle(element).color)).not.toBe(descriptionColor)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await form.getByLabel('团队名称', { exact: true }).fill('未保存的团队')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  page.once('dialog', confirmation => confirmation.dismiss())
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(form.getByLabel('团队名称', { exact: true })).toHaveValue('未保存的团队')
  await page.getByRole('button', { name: '展开或收起侧栏', exact: true }).click()
  const navigation = page.getByRole('dialog')
  await expect(navigation.getByRole('link', { name: '成员', exact: true })).toBeVisible()
  page.once('dialog', confirmation => confirmation.dismiss())
  await navigation.getByRole('link', { name: '账户', exact: true }).click()
  await expect(navigation).toBeVisible()
  await expect(form.getByLabel('团队名称', { exact: true })).toHaveValue('未保存的团队')
  page.once('dialog', confirmation => confirmation.dismiss())
  await navigation.getByRole('link', { name: '成员', exact: true }).click()
  await expect(navigation).toBeVisible()
  page.once('dialog', confirmation => confirmation.accept())
  await navigation.getByRole('link', { name: '成员', exact: true }).click()
  await expect(navigation).not.toBeVisible()
  await expect(page.getByRole('heading', { name: '成员', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

/** The page's painted colour at a point, from a screenshot, so translucent fills are measured as seen. */
async function paintedAt(page: Page, x: number, y: number) {
  const png = (await page.screenshot()).toString('base64')
  return page.evaluate(async ({ png, x, y }) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob())
    const context = new OffscreenCanvas(image.width, image.height).getContext('2d')!
    context.drawImage(image, 0, 0)
    const scale = image.width / window.innerWidth
    return Array.from(context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3))
  }, { png, x, y })
}

test('设置沿用应用顶栏：搜索胶囊和浏览器按钮都在，搜索回到应用并打开 ⌘K', async ({ page }) => {
  await register(page, '/settings?section=preferences')
  const bar = page.locator('[data-slot="window-bar"]')
  await expect(bar.getByRole('button', { name: '全局搜索', exact: true })).toBeVisible()
  await expect(bar.getByRole('button', { name: '浏览器', exact: true })).toBeVisible()
  await bar.getByRole('button', { name: '全局搜索', exact: true }).click()
  await expect(page).not.toHaveURL(/\/settings/)
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('设置搜索没有结果时显示一行提示，不留下团队分组', async ({ page }) => {
  await register(page, '/settings?section=preferences')
  const sidebar = page.locator('[data-slot="settings-list"]')
  await sidebar.getByRole('textbox', { name: '搜索设置', exact: true }).fill('不存在的设置项')
  await expect(sidebar.getByRole('status')).toHaveText('没有匹配的设置')
  await expect(sidebar.locator('[data-slot="sidebar-group"]')).toHaveCount(0)
  await sidebar.getByRole('textbox', { name: '搜索设置', exact: true }).fill('账户')
  await expect(sidebar.getByRole('status')).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: '账户', exact: true })).toBeVisible()
})

test('设置侧栏的搜索框在浅色、深色和半透明窗口里都与侧栏底色区分开', async ({ page }) => {
  await register(page, '/settings?section=preferences')
  const field = page.locator('[data-slot="settings-list"] [data-slot="search-input"]')
  await expect(field.getByRole('textbox', { name: '搜索设置', exact: true })).toBeVisible()
  const cases = [
    { name: 'light', scheme: 'light' as const, translucent: false },
    { name: 'dark', scheme: 'dark' as const, translucent: false },
    { name: 'translucent light', scheme: 'light' as const, translucent: true },
    { name: 'translucent dark', scheme: 'dark' as const, translucent: true },
  ]
  for (const { name, scheme, translucent } of cases) {
    await page.emulateMedia({ colorScheme: scheme })
    // A solid colour stands in for the window material: light behind a light window, dark behind a dark one.
    const material = scheme === 'dark' ? 'rgb(40 40 40)' : 'rgb(200 200 200)'
    await page.evaluate(({ on, material }) => {
      const root = document.documentElement
      if (on) { root.dataset.desktopPlatform = 'darwin'; root.dataset.desktopTranslucent = ''; document.body.style.background = material }
      else { delete root.dataset.desktopTranslucent; document.body.style.background = '' }
    }, { on: translucent, material })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const box = (await field.boundingBox())!
    // Inside the field at its right end (no icon or text there) against the sidebar just below it.
    const inside = await paintedAt(page, box.x + box.width - 6, box.y + box.height / 2)
    const outside = await paintedAt(page, box.x + box.width - 6, box.y + box.height + 3)
    const difference = inside.reduce((sum, value, index) => sum + Math.abs(value - outside[index]), 0)
    expect(difference, `${name}: 搜索框 ${inside} 与侧栏 ${outside} 几乎同色`).toBeGreaterThanOrEqual(24)
    expect(await field.evaluate(element => getComputedStyle(element).borderTopWidth), name).toBe('0px')
  }
})

test('个人工作区有工作区自身的全部设置，只少成员、团队、团队权限和审计日志', async ({ page }) => {
  // Decision 2026-11-02-0203: a new account's own workspace is personal; only what is between people is a team's.
  await register(page, '/settings?section=preferences')
  const sidebar = page.locator('[data-slot="settings-list"]')
  await expect(sidebar.locator('[data-slot="sidebar-group-label"]').first()).toHaveText('账号')
  for (const name of ['常规', 'Bot 与 Agents', '密钥与环境', '用量', '计费', 'API 与订阅']) await expect(sidebar.getByRole('link', { name, exact: true })).toBeVisible()
  for (const name of ['成员', '团队', '团队权限', '审计日志']) await expect(sidebar.getByRole('link', { name, exact: true })).toHaveCount(0)
  for (const path of ['/settings/members', '/settings/teams', '/settings?section=permissions', '/settings?section=audit']) {
    await page.goto(app(path))
    await expect(page).toHaveURL(url => url.pathname === app('/settings') && url.searchParams.get('section') === 'preferences')
    await expect(page.getByRole('heading', { level: 1, name: '偏好设置', exact: true })).toBeVisible()
  }
  // 重新播放引导 is the person's: 偏好设置 holds it in every workspace.
  await expect(page.getByRole('button', { name: '重新播放', exact: true })).toBeEnabled()
  // 「API 与订阅」 keeps the person's own credentials; sharing with a team is a team workspace's.
  await sidebar.getByRole('link', { name: 'API 与订阅', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'API 与订阅', exact: true })).toBeVisible()
  await expect(page.getByText('分享给团队成员', { exact: true })).toHaveCount(0)
  await expect(page.getByText('我的点数也可用于这个团队', { exact: true })).toHaveCount(0)
  // 常规: its own name and address; no 转让, and the personal workspace cannot be deleted.
  await sidebar.getByRole('link', { name: '常规', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toBeEditable()
  await expect(page.getByRole('button', { name: '转让', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '删除', exact: true })).toHaveCount(0)
  await expect(page.getByText('个人工作区不能删除', { exact: true })).toBeVisible()
  // 密钥与环境: the person's own secrets for their bots' runs.
  await sidebar.getByRole('link', { name: '密钥与环境', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: '密钥与环境', exact: true })).toBeVisible()
  await sidebar.getByRole('link', { name: 'Bot 与 Agents', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Bot 与 Agents', exact: true })).toBeVisible()
})
