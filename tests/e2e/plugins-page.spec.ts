import type { Page } from '@playwright/test'
import { test, expect, register, app, rail } from './fixtures'

// The rail's 插件 is the app store; 设置 › 连接 lists only what is connected
// (decision 2026-10-31). Composio is never called: the catalog and the
// person's accounts are controlled answers.
const icon = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 1 1%22/%3E'
const store = (id: string, name: string, description: string, categories = [{ id: 'crm', name: 'crm' }]) => ({ id, name, description, iconUrl: icon, categories, createdAt: '2026-01-01T00:00:00.000Z' })
const CATALOG = {
  configured: true,
  apps: [
    store('gmail', 'Gmail', 'Google’s email service'),
    store('slack', 'Slack', 'Team chat'),
    store('hubspot', 'HubSpot', 'Inbound marketing and CRM platform'),
    store('salesforce', 'Salesforce', 'CRM for sales teams'),
    store('attio', 'Attio', ''),
    store('zoho', 'Zoho', 'Business apps'),
    store('pipedrive', 'Pipedrive', 'Sales pipeline'),
  ],
  popular: ['gmail', 'slack', 'hubspot'],
  latest: ['attio'],
  categories: [{ id: 'crm', name: 'crm', apps: ['gmail', 'slack', 'hubspot', 'salesforce', 'attio', 'zoho', 'pipedrive'] }],
}
const GMAIL = { id: 'fixture-gmail', toolkit: 'gmail', status: 'ACTIVE', enabled: true, alias: null, createdAt: '2026-10-01T00:00:00.000Z', email: 'fixture@example.test', isDefault: true }

async function controlled(page: Page, options: { hold?: () => Promise<void> } = {}) {
  await page.route('**/api/integrations/composio/catalog', route => route.fulfill({ json: CATALOG }))
  await page.route('**/api/integrations/composio', async route => {
    if (route.request().method() !== 'GET') return route.fallback()
    await options.hold?.()
    await route.fulfill({ json: { configured: true, callbackVerifierConfigured: true, webhookConfigured: true, accounts: [GMAIL] } })
  })
}

test('插件 is a store of every app; 设置 › 连接 lists only what is connected', async ({ page }, testInfo) => {
  await controlled(page)
  await register(page, '/?section=plugins')
  // As Codex: 热门 (ours first, then Composio's order) and 新品推荐; no separate section for ours.
  await expect(page.getByRole('heading', { name: '内置', exact: true })).toHaveCount(0)
  for (const section of ['热门', '新品推荐']) await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible()
  // Connected: … opens a menu. Not connected: + starts the connect flow.
  await expect(page.getByRole('button', { name: 'Gmail 的操作', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '连接 Gmail', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '连接 Slack', exact: true }).first()).toBeVisible()
  // Composio's own one-line description; none is made up for an app without one, or for ours.
  await expect(page.getByText('Inbound marketing and CRM platform', { exact: true }).first()).toBeVisible()
  for (const own of ['GitHub', 'Linear', 'Telegram']) await expect(page.getByRole('link', { name: `打开 ${own}`, exact: true })).toBeVisible()
  // 插件 is a full page: no bot list beside it.
  await expect(page.getByRole('list', { name: 'Bot', exact: true })).toHaveCount(0)
  // Moved to 设置 › 设备 / 安全, or removed.
  for (const gone of ['线程运行环境', 'Google 登录', '事件接收', '刷新 GitHub 状态', '在设置中管理']) {
    await expect(page.getByText(gone, { exact: true })).toHaveCount(0)
  }
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await testInfo.attach(`plugins-store-${scheme}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'light' })

  // The … menu manages the connection.
  await page.getByRole('button', { name: 'Gmail 的操作', exact: true }).first().click()
  for (const item of ['管理', '停用', '断开连接']) await expect(page.getByRole('menuitem', { name: item, exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  // A category's › opens all of it.
  await page.getByRole('link', { name: '查看全部crm', exact: true }).click()
  await expect(page).toHaveURL(url => url.searchParams.get('category') === 'c:crm')
  await expect(page.getByRole('link', { name: '打开 Pipedrive', exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: '热门', exact: true })).toBeVisible()

  // Search covers the whole catalog, ours included.
  const search = page.getByRole('textbox', { name: '搜索应用', exact: true })
  await search.fill('pipe')
  await expect(page.getByRole('link', { name: '打开 Pipedrive', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '打开 Gmail', exact: true })).toHaveCount(0)
  await search.fill('git')
  await page.getByRole('link', { name: '打开 GitHub', exact: true }).click()
  await expect(page).toHaveURL(url => url.searchParams.get('app') === 'github')
  await expect(page.getByRole('heading', { name: 'GitHub', exact: true })).toBeVisible()
  // Back returns to the store as it was left: the search still filters it.
  await page.goBack()
  await expect(search).toHaveValue('git')
  await expect(page.getByRole('link', { name: '打开 GitHub', exact: true })).toBeVisible()
  await search.fill('')
  await expect(page.getByRole('heading', { name: '热门', exact: true })).toBeVisible()

  // A store app's own page, from its link.
  await page.goto(app('/?section=plugins&app=hubspot'))
  await expect(page.getByRole('heading', { name: 'HubSpot', exact: true })).toBeVisible()

  await page.goto(app('/settings?section=connections'))
  await expect(page.getByRole('link', { name: '打开 Gmail', exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: '启用 Gmail', exact: true })).toBeChecked()
  for (const store of ['Slack', 'HubSpot']) await expect(page.getByRole('link', { name: `打开 ${store}`, exact: true })).toHaveCount(0)
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

test('插件 opens on the last state it read: no loading line, no … / + flip', async ({ page }) => {
  let hold = false
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  await controlled(page, { hold: async () => { if (hold) await held } })
  try {
    await register(page, '/?section=plugins')
    const gmail = page.getByRole('button', { name: 'Gmail 的操作', exact: true }).first()
    await expect(gmail).toBeVisible()

    await rail(page, '主页').click()
    await expect(page.getByRole('link', { name: '打开 Gmail', exact: true })).toHaveCount(0)
    // Every later read waits: whatever the revisit shows comes from the cache.
    hold = true
    await rail(page, '插件').click()
    await expect(gmail).toBeVisible()
    await expect(page.getByRole('button', { name: '连接 Gmail', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '连接 Slack', exact: true }).first()).toBeVisible()
    await expect(page.getByText('正在读取集成…', { exact: true })).toHaveCount(0)
  } finally {
    release()
  }
})

test('插件 store stays put while the connected apps load', async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await controlled(page, { hold: () => held })
  await register(page, '/?section=plugins')
  const gmail = page.getByRole('link', { name: '打开 Gmail', exact: true }).first()
  await expect(gmail).toBeVisible()
  // Loading is announced, not drawn: no visible line above the store.
  await expect(page.getByRole('status').filter({ hasText: '正在读取集成…' })).toHaveClass(/sr-only/)
  const before = await gmail.boundingBox()
  release()
  await expect(page.locator('[data-slot="app-row-pending"]')).toHaveCount(0)
  expect((await gmail.boundingBox())?.y).toBe(before?.y)
})
