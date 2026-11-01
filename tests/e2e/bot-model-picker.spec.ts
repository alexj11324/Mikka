import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, register } from './fixtures'

// The model chip in a chat's composer (decision 2026-10-31-2330), against the
// real application, PostgreSQL and server actions. Only the connected
// subscriptions are seeded: no provider sign-in runs in the browser suite.
let pool: Pool | null = null
const db = () => pool ??= new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
test.afterAll(async () => { await pool?.end() })

async function seed(page: Page) {
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  if (!cookie) throw new Error('需要已登录的页面。')
  const { rows: [session] } = await db().query<{ userId: string }>('SELECT "userId" FROM session WHERE token = $1', [decodeURIComponent(cookie.value).split('.')[0]])
  const { rows: [member] } = await db().query<{ workspaceId: string }>('SELECT "workspaceId" FROM mikka_workspace_members WHERE "userId" = $1 AND status = $2 ORDER BY "createdAt" LIMIT 1', [session.userId, 'active'])
  const connections: Record<string, string> = {}
  for (const [provider, route, model] of [['claude', 'claude_cpa', 'claude-e2e-model'], ['codex', 'codex_cpa', 'codex-e2e-model']] as const) {
    const connection = randomUUID()
    connections[provider] = connection
    await db().query(`INSERT INTO byos_connections (id, "ownerId", "workspaceId", provider, state, epoch, "secretName", "secretDigest", "providerSubject", quota)
      VALUES ($1, $2, $3, $4, 'connected', 1, $5, $6, 'e2e-subject', $7)`, [connection, session.userId, member.workspaceId, provider, `e2e-fixture-${connection}`, 'a'.repeat(64),
      provider === 'claude' ? JSON.stringify({ vendor: 'claude_code', source: 'official', status: 'ok', plan: 'Max', windows: [], observedAt: new Date().toISOString() }) : null])
    await db().query(`INSERT INTO byos_bindings (id, "ownerId", "workspaceId", "consumerId", "connectionId", "connectionRevision", route, "modelId")
      VALUES ($1, $2, $3, 'e2e-consumer', $4, 1, $5, $6)`, [randomUUID(), session.userId, member.workspaceId, connection, route, model])
  }
  return { userId: session.userId, workspaceId: member.workspaceId, connections }
}

const choice = async (userId: string) => (await db().query<{ bindingId: string | null; modelId: string | null }>(
  `SELECT c."bindingId", b."modelId" FROM bot_model_choices c LEFT JOIN byos_bindings b ON b.id = c."bindingId" WHERE c."ownerId" = $1 AND c."botKey" = (SELECT "botId"::text FROM coordinator_bots WHERE "ownerId" = $1)`, [userId])).rows

test('Coordinator 输入框的模型选择器：只列可用的凭据，按 Bot 保存，账号断开后显示不可用', async ({ page }, testInfo) => {
  await register(page)
  const { userId, connections } = await seed(page)
  await page.reload()
  await page.getByRole('button', { name: 'Coordinator', exact: true }).first().click()

  // Nothing picked: the chip shows what the next run resolves to, a Claude subscription first.
  const chip = page.getByTestId('bot-model-chip')
  await expect(chip).toHaveAccessibleName('模型：claude-e2e-model')
  expect(await choice(userId)).toEqual([])

  await chip.click()
  const menu = page.getByRole('menu')
  await expect(menu.getByText('Mikka', { exact: true })).toBeVisible()
  await expect(menu.getByText('Claude Max', { exact: true })).toBeVisible()
  await expect(menu.getByText('ChatGPT', { exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitemradio')).toHaveCount(3)
  // A model picker only: no Agent (Claude Code / Codex) in the Coordinator's menu.
  await expect(menu.getByText(/Claude Code|Codex/)).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: /管理 API 与订阅/ })).toBeVisible()
  // The menu opens right above the chip, left-aligned with it.
  const placement = async () => {
    const [chipBox, menuBox] = [await chip.boundingBox(), await menu.boundingBox()]
    return { left: Math.round(menuBox!.x - chipBox!.x), gap: Math.round(chipBox!.y - (menuBox!.y + menuBox!.height)) }
  }
  await expect.poll(placement).toEqual({ left: 0, gap: 4 })
  await testInfo.attach('model-menu', { body: await page.screenshot(), contentType: 'image/png' })

  // 刷新模型列表: a subscription connected while the menu is open shows after a refresh, and the menu stays open.
  const fresh = randomUUID()
  await db().query(`INSERT INTO byos_connections (id, "ownerId", "workspaceId", provider, state, epoch, "secretName", "secretDigest", "providerSubject")
    SELECT $1, "ownerId", "workspaceId", 'claude', 'connected', 1, $2, $3, 'e2e-subject' FROM byos_connections WHERE id = $4`, [fresh, `e2e-fixture-${fresh}`, 'a'.repeat(64), connections.claude])
  await db().query(`INSERT INTO byos_bindings (id, "ownerId", "workspaceId", "consumerId", "connectionId", "connectionRevision", route, "modelId")
    SELECT $1, "ownerId", "workspaceId", 'e2e-consumer', $2, 1, 'claude_cpa', 'claude-fresh-e2e-model' FROM byos_connections WHERE id = $2`, [randomUUID(), fresh])
  const refresh = menu.getByTestId('bot-model-refresh')
  await expect(refresh).toHaveAccessibleName('刷新模型列表')
  await refresh.click()
  await expect(menu.getByRole('menuitemradio', { name: /claude-fresh-e2e-model/ })).toBeVisible()
  await expect(menu).toBeVisible()
  // A refresh that fails says so inside the menu, and the row retries.
  const isAction = (request: import('@playwright/test').Request) => request.method() === 'POST' && Boolean(request.headers()['next-action'])
  // The refresh gets an answer that is not the action's: it fails without a network error.
  await page.route('**/*', route => isAction(route.request()) ? route.fulfill({ status: 200, contentType: 'text/plain', body: 'unavailable' }) : route.fallback())
  await refresh.click()
  const retry = menu.getByRole('menuitem', { name: '刷新失败，重试' })
  await expect(retry).toBeVisible()
  await page.unroute('**/*')
  await retry.click()
  await expect(retry).toHaveCount(0)
  await expect(menu).toBeVisible()
  await db().query(`UPDATE byos_connections SET state = 'disconnected' WHERE id = $1`, [fresh])
  await refresh.click()
  await expect(menu.getByRole('menuitemradio', { name: /claude-fresh-e2e-model/ })).toHaveCount(0)
  await menu.getByRole('menuitemradio', { name: /codex-e2e-model/ }).click()

  await expect(chip).toHaveAccessibleName('模型：codex-e2e-model')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect.poll(async () => (await choice(userId)).map(row => row.modelId)).toEqual(['codex-e2e-model'])
  await page.reload()
  await expect(page.getByTestId('bot-model-chip')).toHaveAccessibleName('模型：codex-e2e-model')

  // Mikka 默认 on purpose is saved too, as a choice without a binding.
  await page.getByTestId('bot-model-chip').click()
  await page.getByRole('menu').getByRole('menuitemradio', { name: /Mikka 默认/ }).click()
  await expect(page.getByTestId('bot-model-chip')).toHaveAccessibleName('模型：Mikka 默认')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect.poll(async () => (await choice(userId)).map(row => row.bindingId)).toEqual([null])

  // A pick whose account goes away while it is being saved is answered, not a 500: the chip goes back to
  // what it was and says 未保存. The save is held until the account is gone (the race the browser's one-at-a-time
  // server actions make possible); the runtime guard fails the test on any 5xx.
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let saving = false
  await page.route('**/*', async route => {
    const request = route.request()
    if (request.method() === 'POST' && request.headers()['next-action'] && /^\[null,"[0-9a-f-]{36}"\]$/.test(request.postData() ?? '')) {
      saving = true
      await held
    }
    await route.fallback()
  })
  await page.getByTestId('bot-model-chip').click()
  await page.getByRole('menu').getByRole('menuitemradio', { name: /claude-e2e-model/ }).click()
  await expect.poll(() => saving).toBe(true)
  await db().query(`UPDATE byos_connections SET state = 'disconnected' WHERE id = $1`, [connections.claude])
  release()
  await expect(page.getByTestId('bot-model-chip')).toHaveAccessibleName('模型：Mikka 默认')
  await expect(page.getByText('未保存', { exact: true })).toBeVisible()
  expect((await choice(userId)).map(row => row.bindingId)).toEqual([null])
  await page.unroute('**/*')
  await db().query(`UPDATE byos_connections SET state = 'connected' WHERE id = $1`, [connections.claude])

  // The picked account goes away: the chip names it, marked unavailable, and the menu no longer offers it.
  await page.getByTestId('bot-model-chip').click()
  await page.getByRole('menu').getByRole('menuitemradio', { name: /codex-e2e-model/ }).click()
  await expect(page.getByTestId('bot-model-chip')).toHaveAccessibleName('模型：codex-e2e-model')
  // The chip shows the pick at once; the reload below must come after it is saved, or it cancels the save.
  await expect.poll(async () => (await choice(userId)).map(row => row.modelId)).toEqual(['codex-e2e-model'])
  await db().query(`UPDATE byos_connections SET state = 'disconnected' WHERE id = $1`, [connections.codex])
  await page.reload()
  await expect(page.getByTestId('bot-model-chip')).toHaveAccessibleName('模型：codex-e2e-model，不可用')
  await expect(page.getByTestId('bot-model-chip')).toHaveAttribute('data-unavailable', 'true')
  await page.getByTestId('bot-model-chip').click()
  await expect(page.getByRole('menu').getByRole('menuitemradio')).toHaveCount(2)
  await expect(page.getByRole('menu').getByRole('menuitemradio', { checked: true })).toHaveCount(0)
  await testInfo.attach('model-menu-unavailable', { body: await page.screenshot(), contentType: 'image/png' })
  await page.keyboard.press('Escape')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByTestId('bot-model-chip').click()
  await expect(page.getByRole('menu')).toBeVisible()
  await testInfo.attach('model-menu-dark', { body: await page.screenshot(), contentType: 'image/png' })
})
