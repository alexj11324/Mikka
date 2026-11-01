import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test as base, expect, app, browserClientHeaders, skipOnboarding } from './fixtures'

// 停止 in a group: while a bot answers, send is stop (Esc too); the real stop
// route ends the turn and the chat says 已停止. The worker side (abort in
// flight, nothing posted after) is lib/coordinator/group-turns.test.ts.

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Group chat acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

type Group = { id: string; title: string; email: string; cookies: Awaited<ReturnType<import('@playwright/test').APIRequestContext['storageState']>>['cookies'] }

// A group whose bot is answering the person's message: a running turn, as a worker holds it mid-reply.
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
      const title = `发版群 ${tag}`, botId = randomUUID(), messageId = randomUUID()
      const created = await client.post(app('/api/conversations'), { headers: { origin }, data: { workspaceId, title } })
      expect(created.status()).toBe(201)
      const { id } = await created.json() as { id: string }
      const pool = isolatedPool()
      try {
        await pool.query('INSERT INTO bots (id, "workspaceId", "ownerId", name, color, shape) VALUES ($1, $2, $3, $4, \'orange\', \'hexagone\')', [botId, workspaceId, userId, `值班${tag}`])
        await pool.query('INSERT INTO conversation_members ("conversationId", "memberType", "memberId", role) VALUES ($1, \'bot\', $2, \'member\')', [id, botId])
        await pool.query('UPDATE conversations SET "lastPosition"="lastPosition"+1 WHERE id=$1', [id])
        await pool.query('INSERT INTO conversation_messages (id, "conversationId", position, "authorType", "authorId", body, mentions) SELECT $1, $2, "lastPosition", \'user\', $3, $4, \'[]\' FROM conversations WHERE id=$2', [messageId, id, userId, '写一份发布清单'])
        await pool.query('INSERT INTO group_turns ("messageId", "conversationId", "userId", status, "botId") VALUES ($1, $2, $3, \'running\', $4)', [messageId, id, userId, botId])
      } finally { await pool.end() }
      // A live worker holds the group's turn lock while it answers; without it, the next page read recovers the turn as interrupted.
      const worker = isolatedPool()
      const held = await worker.connect()
      try {
        await held.query(`SELECT pg_advisory_lock(hashtextextended(current_database() || '.' || current_schema() || '.group-turn.' || $1, 0))`, [id])
        await use({ id, title, email, cookies: (await client.storageState()).cookies })
      } finally { held.release(true); await worker.end() }
    } finally { await client.dispose() }
  },
})

async function openAnswering(page: import('@playwright/test').Page, group: Group) {
  await page.context().addCookies(group.cookies)
  await page.goto(app('/'))
  await skipOnboarding(page, group.email)
  await page.getByRole('list', { name: 'Bot', exact: true }).getByRole('button', { name: group.title, exact: true }).click()
  const chat = page.getByRole('region', { name: group.title, exact: true })
  await expect(chat.getByRole('listitem', { name: '正在回复', exact: true })).toBeVisible()
  return chat
}

test('while a bot answers in a group, send is stop; stopping ends the turn and says 已停止', async ({ page, group }) => {
  const chat = await openAnswering(page, group)
  const stop = chat.getByRole('button', { name: '停止', exact: true })
  await expect(stop).toBeVisible()
  const composer = chat.getByRole('textbox', { name: `给 ${group.title} 发消息`, exact: true })
  await composer.fill('再加一项')
  await expect(chat.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await composer.fill('')
  const stopped = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/conversations/${group.id}/stop`))
  await stop.click()
  expect((await stopped).status()).toBe(200)
  await expect(chat.getByRole('status').filter({ hasText: '已停止' })).toBeVisible()
  await expect(chat.getByRole('listitem', { name: '正在回复', exact: true })).toHaveCount(0)
  await expect(chat.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
})

test('Esc in a group composer stops the reply as the stop button does', async ({ page, group }) => {
  const chat = await openAnswering(page, group)
  await chat.getByRole('textbox', { name: `给 ${group.title} 发消息`, exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(chat.getByRole('status').filter({ hasText: '已停止' })).toBeVisible()
})
