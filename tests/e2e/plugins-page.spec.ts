import { test, expect, register, app, rail } from './fixtures'

// 插件 (rail) and 设置 › 连接 render the same list (decisions 2026-10-31).
const APPS = ['Gmail', 'Google 日历', 'Notion', 'Slack', 'GitHub', 'Linear', 'Telegram']

test('插件 is one list of apps, shared with 设置 › 连接', async ({ page }, testInfo) => {
  await register(page, '/?section=plugins')
  await expect(page.getByRole('tab', { name: /^应用/ })).toContainText(String(APPS.length))
  for (const name of APPS) await expect(page.getByRole('link', { name: `打开 ${name}`, exact: true })).toBeVisible()
  // 插件 is a full page: no bot list beside it.
  await expect(page.getByRole('list', { name: 'Bot', exact: true })).toHaveCount(0)
  // Moved to 设置 › 设备 / 安全, or removed.
  for (const gone of ['线程运行环境', 'Google 登录', '事件接收', '刷新 GitHub 状态', '在设置中管理']) {
    await expect(page.getByText(gone, { exact: true })).toHaveCount(0)
  }
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await testInfo.attach(`plugins-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'light' })

  await page.getByRole('textbox', { name: '搜索应用', exact: true }).fill('git')
  await expect(page.getByRole('link', { name: '打开 GitHub', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '打开 Gmail', exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: '打开 GitHub', exact: true }).click()
  await expect(page).toHaveURL(url => url.searchParams.get('app') === 'github')
  await expect(page.getByRole('heading', { name: 'GitHub', exact: true })).toBeVisible()
  // Back returns to the list as it was left: the search still filters it.
  await page.goBack()
  await expect(page.getByRole('textbox', { name: '搜索应用', exact: true })).toHaveValue('git')
  await expect(page.getByRole('link', { name: '打开 GitHub', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '搜索应用', exact: true }).fill('')
  await expect(page.getByRole('link', { name: '打开 Gmail', exact: true })).toBeVisible()

  await page.goto(app('/settings?section=connections'))
  for (const name of APPS) await expect(page.getByRole('link', { name: `打开 ${name}`, exact: true })).toBeVisible()
  await expect(page.getByText('事件接收', { exact: true })).toHaveCount(0)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await testInfo.attach(`settings-connections-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(app('/settings?section=connections&app=telegram'))
  await expect(page.getByRole('heading', { name: 'Telegram', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '刷新状态', exact: true })).toHaveCount(0)
  await testInfo.attach('settings-connections-telegram', { body: await page.screenshot(), contentType: 'image/png' })
})

test('插件 opens on the last state it read: no loading line, no 连接 flip', async ({ page }) => {
  // A controlled Composio answer: Gmail connected and on. No provider is called.
  let hold = false
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/integrations/composio', async route => {
    if (route.request().method() !== 'GET') return route.fallback()
    if (hold) await held
    await route.fulfill({ json: { configured: true, callbackVerifierConfigured: true, webhookConfigured: true, accounts: [
      { id: 'fixture-gmail', toolkit: 'gmail', status: 'ACTIVE', enabled: true, alias: null, createdAt: '2026-10-01T00:00:00.000Z', email: 'fixture@example.test', isDefault: true },
    ] } })
  })
  try {
    await register(page, '/?section=plugins')
    const gmail = page.getByRole('switch', { name: '启用 Gmail', exact: true })
    await expect(gmail).toBeChecked()

    await rail(page, '主页').click()
    await expect(page.getByRole('link', { name: '打开 Gmail', exact: true })).toHaveCount(0)
    // Every later read waits: whatever the revisit shows comes from the cache.
    hold = true
    await rail(page, '插件').click()
    await expect(gmail).toBeChecked()
    // 连接 only on the three apps without an account; no line above the list.
    await expect(page.getByRole('button', { name: '连接', exact: true })).toHaveCount(3)
    await expect(page.getByText('正在读取集成…', { exact: true })).toHaveCount(0)
  } finally {
    release()
  }
})
