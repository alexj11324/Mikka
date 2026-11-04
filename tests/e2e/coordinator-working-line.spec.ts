import { randomUUID } from 'node:crypto'
import type { Page, TestInfo } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, register } from './fixtures'

// The Thinking row (「思考中」) is for work the person is waiting on. After the turn
// stores its reply, the workflow still finishes up (execution record, phone
// push decision, next inbox read, lease release) for a few seconds; the line
// must not stay under the finished reply. A message sent meanwhile is still
// work to come, so the line shows for it.
//
// The state is the real server's (`chatView` over seeded rows in the isolated
// database). The browser run has no model key, so the chat action reports the
// Coordinator unavailable; the route below marks it available and takes
// `working` from `GET /api/coordinator/messages`, which returns chatView as is.

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('This spec requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

const HOLDER = 'e2e-finishing-turn'
const ASKED = 'test'
const REPLY = '收到，测试消息已收到。'
const WORKING = '思考中'

/** The person asked, the turn stored its reply, and it still holds its lease while it finishes up. */
async function seedFinishingTurn(email: string, { queued }: { queued?: string } = {}) {
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [bot] } = await pool.query<{ botId: string }>('SELECT "botId" FROM coordinator_bots WHERE "ownerId" = $1 LIMIT 1', [user.id])
    const insert = (position: number, message: unknown) => pool.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), user.id, bot.botId, position, JSON.stringify(message)])
    await insert(1, { role: 'user', content: ASKED })
    await insert(2, { role: 'assistant', content: [{ type: 'text', text: REPLY }], mikkaStreamId: `${HOLDER}:0` })
    await pool.query(`INSERT INTO coordinator_sessions ("userId", "botId", "leaseHolder", "leaseUntil") VALUES ($1, $2, $3, now() + interval '10 minutes')
      ON CONFLICT ON CONSTRAINT coordinator_sessions_chat_key DO UPDATE SET "leaseHolder" = $3, "leaseUntil" = now() + interval '10 minutes'`, [user.id, bot.botId, HOLDER])
    if (queued) await pool.query(`INSERT INTO coordinator_events (id, "userId", "botId", kind, "dedupeKey", payload, tier, "wakeAttempts") VALUES ($1, $2, $3, 'user_message', $4, $5, 'attention', 0)`,
      [randomUUID(), user.id, bot.botId, `e2e-queued-${randomUUID()}`, JSON.stringify({ text: queued })])
  } finally { await pool.end() }
}

/** The chat action as the server answers it, with the Coordinator available and `working` from chatView. */
async function availableCoordinator(page: Page) {
  let chatAction: string | null = null
  await page.route('**/*', async route => {
    const request = route.request()
    const actionId = request.headers()['next-action']
    if (request.method() !== 'POST' || !actionId || (chatAction && actionId !== chatAction)) return route.fallback()
    if (!chatAction && (request.postData() ?? '').trim() !== '[]') return route.fallback()
    const response = await route.fetch()
    const body = await response.text()
    if (!/"items"\s*:/.test(body) || !/"working"\s*:/.test(body)) return route.fulfill({ response, body })
    chatAction = actionId
    const view = await (await page.request.get('/mikka/api/coordinator/messages')).json() as { working: boolean }
    return route.fulfill({ response, body: body.replace(/"working"\s*:\s*(true|false)/, `"working":${view.working}`).replace(/"enabled"\s*:\s*false/, '"enabled":true') })
  })
}

const conversation = (page: Page) => page.getByRole('region', { name: '与 Coordinator 的对话', exact: true })

async function openChat(page: Page, testInfo: TestInfo, shot: string) {
  await page.reload()
  await page.getByRole('button', { name: /^Coordinator(，正在工作)?$/ }).first().click()
  await expect(conversation(page).getByText(REPLY)).toBeVisible()
  const path = testInfo.outputPath(`${shot}.png`)
  await page.screenshot({ path })
  await testInfo.attach(shot, { path, contentType: 'image/png' })
}

test('a stored reply is not followed by 正在处理 while its turn finishes up', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await availableCoordinator(page)
  const { email } = await register(page)
  await expect(page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })).toBeVisible()
  await seedFinishingTurn(email)
  await openChat(page, testInfo, 'reply-stored-turn-finishing')
  await expect(conversation(page).getByText(WORKING)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
})

test('a message sent while the turn finishes up still shows the Coordinator working', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await availableCoordinator(page)
  const { email } = await register(page)
  await expect(page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })).toBeVisible()
  await seedFinishingTurn(email, { queued: '再测一次' })
  await openChat(page, testInfo, 'reply-stored-message-queued')
  await expect(conversation(page).getByText('再测一次')).toBeVisible()
  await expect(conversation(page).getByText(WORKING)).toBeVisible()
})
