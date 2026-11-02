import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, openSearch, openCreateIssue, conversationPill } from './fixtures'

// Usability review D4/M10 and T4. Neither was ever built (the first review listed both as needing a decision),
// so the second review read them as regressions; these specs keep them from going missing again.

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('This spec requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

test('⌘K finds a thread by what it was asked and opens it (D4/M10)', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { email } = await register(page)
  const prompt = `复现 Safari 17 登录页白屏 ${randomUUID().slice(0, 8)}`
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const agentId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Coordinator'])
    await pool.query('INSERT INTO agent_runs (id, "userId", "agentId", status, prompt, "lastReply") VALUES ($1, $2, $3, $4, $5, $6)', [randomUUID(), user.id, agentId, 'running', prompt, '写好了失败的 Playwright 用例'])
  } finally { await pool.end() }
  await page.reload()

  const search = await openSearch(page)
  await search.getByRole('combobox', { name: '全局搜索', exact: true }).fill('Safari 白屏')
  const hit = search.locator('[cmdk-group]').filter({ has: page.getByText('线程', { exact: true }) }).getByRole('option').filter({ hasText: prompt })
  await expect(hit).toBeVisible()
  await expect(hit).toContainText('写好了失败的 Playwright 用例')
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await testInfo.attach(`search-thread-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await hit.click()
  await expect(search).toBeHidden()
  await expect(page.getByRole('region', { name: prompt, exact: true })).toBeVisible()
})

test('新建任务 hands the request to the bot picked in 交给哪个 Bot (T4)', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { email } = await register(page)
  await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click()
  const newBot = page.getByRole('dialog', { name: '新建 Bot' })
  await newBot.getByLabel('名字', { exact: true }).fill('前端助手')
  await newBot.getByRole('button', { name: '创建', exact: true }).click()
  await expect(newBot).toBeHidden()
  await expect(conversationPill(page)).toHaveText('前端助手')
  const pool = isolatedPool()
  let botId: string
  try {
    const { rows: [bot] } = await pool.query<{ id: string }>('SELECT b.id FROM bots b JOIN "user" u ON u.id = b."ownerId" WHERE u.email = $1 AND b.name = $2', [email, '前端助手'])
    botId = bot.id
  } finally { await pool.end() }

  const dialog = await openCreateIssue(page)
  const picker = dialog.getByRole('combobox', { name: '交给哪个 Bot', exact: true })
  await expect(picker).toHaveText(/Coordinator/)
  await picker.click()
  await page.getByRole('option', { name: '前端助手', exact: true }).click()
  await expect(picker).toHaveText(/前端助手/)
  const request = `登录页加 Safari WebKit 冒烟用例 ${randomUUID().slice(0, 8)}`
  await dialog.getByLabel('任务描述', { exact: true }).fill(request)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await testInfo.attach(`new-task-bot-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  // The request goes to that bot's own chat, not the Coordinator's.
  const sent = page.waitForRequest(item => item.method() === 'POST' && !!item.headers()['next-action'] && item.postData()?.includes(request) === true)
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click()
  const body = (await sent).postData() ?? ''
  expect(body).toContain(botId)
})
