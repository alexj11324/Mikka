import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, app } from './fixtures'

// The web group chat sends through the same API as the phone: a message shows
// at once, names the bots it @mentions, and a failed send stays with 重试.

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Group chat acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

test.use({ expectedConsoleErrors: [{ path: '/mikka/', message: 'Failed to load resource: net::ERR_FAILED' }] })

test('a group chat sends from the web, names @bots, and retries a failed send', async ({ page }) => {
  const { email } = await register(page)
  const workspaceId = (await (await page.request.get(app('/api/workspace'))).json()).workspace.id as string
  const tag = randomUUID().slice(0, 8)
  const title = `发版群 ${tag}`, botName = `值班${tag}`
  const headers = { origin: new URL(page.url()).origin }
  const created = await page.request.post(app('/api/conversations'), { headers, data: { workspaceId, title } })
  expect(created.status()).toBe(201)
  const { id: groupId } = await created.json() as { id: string }
  const botId = randomUUID()
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    await pool.query('INSERT INTO bots (id, "workspaceId", "ownerId", name, color, shape) VALUES ($1, $2, $3, $4, \'orange\', \'hexagone\')', [botId, workspaceId, user.id, botName])
    await pool.query('INSERT INTO conversation_members ("conversationId", "memberType", "memberId", role) VALUES ($1, \'bot\', $2, \'member\')', [groupId, botId])
  } finally { await pool.end() }
  await page.reload()

  await page.getByRole('list', { name: 'Bot', exact: true }).getByRole('button', { name: title, exact: true }).click()
  const chat = page.getByRole('region', { name: title, exact: true })
  const composer = chat.getByRole('textbox', { name: `给 ${title} 发消息`, exact: true })
  await expect(composer).toBeEnabled()

  // Sent: the bubble shows, and the server stored it with the @mentioned bot.
  const first = `@${botName} 看下发版阻塞`
  const posted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/api/conversations/${groupId}/messages`))
  await composer.fill(first)
  await composer.press('Enter')
  expect((await posted).postDataJSON()).toEqual({ body: first, mentions: [{ memberType: 'bot', memberId: botId }] })
  await expect(composer).toHaveValue('')
  const messages = chat.getByRole('list', { name: '群聊消息', exact: true })
  await expect(messages.getByText(first, { exact: true })).toBeVisible()
  await expect(messages.locator('[data-pending]')).toHaveCount(0)

  // Failed: it stays with 未发送 and 重试; 重试 sends it once.
  const second = '合入后再回归一次'
  const route = `**/api/conversations/${groupId}/messages`
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

  const stored = await (await page.request.get(app(`/api/conversations/${groupId}/messages`))).json() as { messages: { body: string }[] }
  expect(stored.messages.map(message => message.body).filter(body => body === first || body === second).sort()).toEqual([first, second].sort())
})
