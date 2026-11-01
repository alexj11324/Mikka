import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, watchRuntime, app } from './fixtures'

// The bot list (R-01): bots and group chats, each row with a plain preview line.
// The group and the person's message go through the real group API; the bot's
// own rows (its chat line and its group message) are written directly, so no
// model turn is queued.

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Bot list acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

test('the bot list shows group chats and plain previews; a group shows each bot by name and avatar', async ({ page, context }) => {
  const errors = watchRuntime(context)
  const { email } = await register(page)
  const workspaceId = (await (await page.request.get(app('/api/workspace'))).json()).workspace.id as string
  const tag = randomUUID().slice(0, 8)
  const botName = `值班 ${tag}`, title = `发版群 ${tag}`
  const headers = { origin: new URL(page.url()).origin }
  const created = await page.request.post(app('/api/conversations'), { headers, data: { workspaceId, title } })
  expect(created.status()).toBe(201)
  const { id: groupId } = await created.json() as { id: string }
  expect((await page.request.post(app(`/api/conversations/${groupId}/messages`), { headers, data: { body: '大家同步一下阻塞' } })).status()).toBe(201)

  const pool = isolatedPool()
  const botId = randomUUID()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    await pool.query('INSERT INTO bots (id, "workspaceId", "ownerId", name, color, shape) VALUES ($1, $2, $3, $4, \'orange\', \'hexagone\')', [botId, workspaceId, user.id, botName])
    // The bot's latest chat line is an OpenUI card whose source must never show.
    const card = 'root = Stack([tabs])\ntabs = BeTabs([{title: "现象", children: [TextContent("E2B 返回 429 后一直重试。")]}])'
    await pool.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1, $2, $3, 1, $4)', [randomUUID(), user.id, botId, JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: card }] })])
    await pool.query('INSERT INTO conversation_members ("conversationId", "memberType", "memberId", role) VALUES ($1, \'bot\', $2, \'member\')', [groupId, botId])
    await pool.query('INSERT INTO conversation_messages (id, "conversationId", position, "authorType", "authorId", body) VALUES ($1, $2, 2, \'bot\', $3, \'收到，合入后回归。\')', [randomUUID(), groupId, botId])
    await pool.query('UPDATE conversations SET "lastPosition" = 2 WHERE id = $1', [groupId])
  } finally { await pool.end() }
  await page.reload()

  const list = page.getByRole('list', { name: 'Bot', exact: true })
  const botRow = list.getByRole('button', { name: botName, exact: true })
  await expect(botRow).toContainText('现象')
  await expect(botRow).not.toContainText('TextContent')
  const groupRow = list.getByRole('button', { name: title, exact: true })
  await expect(groupRow).toContainText('收到，合入后回归。')

  await groupRow.click()
  await expect(groupRow).toHaveAttribute('aria-current', 'page')
  const messages = page.getByRole('region', { name: title, exact: true }).getByRole('list', { name: '群聊消息', exact: true })
  const reply = messages.getByRole('listitem').filter({ hasText: '收到，合入后回归。' })
  await expect(reply.getByText(botName, { exact: true })).toBeVisible()
  await expect(reply.locator('[data-slot="bot-avatar"][data-color="orange"][data-shape="hexagone"]')).toBeVisible()
  expect(errors).toEqual([])
})
