import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test as base, expect, app, browserClientHeaders, skipOnboarding } from './fixtures'

// The web group chat sends through the same API as the phone: a message shows
// at once, names the bots it @mentions, and a failed send stays with 重试.

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Group chat acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

type Group = { id: string; title: string; botId: string; botName: string; email: string; cookies: Awaited<ReturnType<import('@playwright/test').APIRequestContext['storageState']>>['cookies'] }

// The person, their group and its bot exist before the page opens, so the one
// browser network fault below can be expected at its exact URL.
const test = base.extend<{ group: Group }>({
  group: async ({ playwright, baseURL }, use) => {
    const client = await playwright.request.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
    const origin = new URL(baseURL!).origin
    const email = `e2e-${randomUUID()}@example.com`
    try {
      const signed = await client.post(app('/api/auth/sign-up/email'), { headers: { origin }, data: { email, password: randomBytes(32).toString('base64url'), name: '回归测试成员' } })
      expect(signed.ok()).toBeTruthy()
      const userId = (await signed.json()).user.id as string
      const workspaceId = (await (await client.get(app('/api/workspace'))).json()).workspace.id as string
      const tag = randomUUID().slice(0, 8)
      const title = `发版群 ${tag}`, botName = `值班${tag}`, botId = randomUUID()
      const created = await client.post(app('/api/conversations'), { headers: { origin }, data: { workspaceId, title } })
      expect(created.status()).toBe(201)
      const { id } = await created.json() as { id: string }
      const pool = isolatedPool()
      try {
        await pool.query('INSERT INTO bots (id, "workspaceId", "ownerId", name, color, shape) VALUES ($1, $2, $3, $4, \'orange\', \'hexagone\')', [botId, workspaceId, userId, botName])
        await pool.query('INSERT INTO conversation_members ("conversationId", "memberType", "memberId", role) VALUES ($1, \'bot\', $2, \'member\')', [id, botId])
      } finally { await pool.end() }
      await use({ id, title, botId, botName, email, cookies: (await client.storageState()).cookies })
    } finally { await client.dispose() }
  },
  // The aborted send is the failure under test; its browser log is expected once, at that URL.
  expectedConsoleErrors: async ({ group }, use) => {
    await use([{ path: app(`/api/conversations/${group.id}/messages`), message: 'Failed to load resource: net::ERR_FAILED' }])
  },
})

test('a group chat sends from the web, names @bots, and retries a failed send', async ({ page, group }) => {
  await page.context().addCookies(group.cookies)
  await page.goto(app('/'))
  await skipOnboarding(page, group.email)

  await page.getByRole('list', { name: 'Bot', exact: true }).getByRole('button', { name: group.title, exact: true }).click()
  const chat = page.getByRole('region', { name: group.title, exact: true })
  const composer = chat.getByRole('textbox', { name: `给 ${group.title} 发消息`, exact: true })
  await expect(composer).toBeEnabled()

  // Sent: the bubble shows, and the server stored it with the @mentioned bot.
  const first = `@${group.botName} 看下发版阻塞`
  const posted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/api/conversations/${group.id}/messages`))
  await composer.fill(first)
  await composer.press('Enter')
  expect((await posted).postDataJSON()).toEqual({ body: first, mentions: [{ memberType: 'bot', memberId: group.botId }] })
  await expect(composer).toHaveValue('')
  const messages = chat.getByRole('list', { name: '群聊消息', exact: true })
  await expect(messages.getByText(first, { exact: true })).toBeVisible()
  await expect(messages.locator('[data-pending]')).toHaveCount(0)

  // Failed: it stays with 未发送 and 重试; 重试 sends it once.
  const second = '合入后再回归一次'
  const route = `**/api/conversations/${group.id}/messages`
  await page.route(route, request => request.request().method() === 'POST' ? request.abort('failed') : request.fallback())
  await composer.fill(second)
  await composer.press('Enter')
  const failed = messages.locator('[data-pending="failed"]')
  await expect(failed).toContainText(second)
  await expect(failed.getByRole('alert')).toContainText('未发送')
  await page.unroute(route)
  await failed.getByRole('button', { name: '重试', exact: true }).click()
  await expect(messages.locator('[data-pending]')).toHaveCount(0)
  await expect(messages.getByText(second, { exact: true })).toHaveCount(1)

  const stored = await (await page.request.get(app(`/api/conversations/${group.id}/messages`))).json() as { messages: { body: string }[] }
  expect(stored.messages.map(message => message.body).filter(body => body === first || body === second).sort()).toEqual([first, second].sort())
})
