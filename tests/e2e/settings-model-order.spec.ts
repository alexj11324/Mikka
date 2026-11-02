import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, registerInTeam } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// 模型与订阅 › 运行位置 and 允许使用的模型 (decision 2026-11-02-1400). Real
// application, real PostgreSQL, real server actions. Only a connected account's
// catalogue (its bindings) and a computer's report are seeded: no provider login
// or daemon runs in the browser suite. Model ids stand for reported values.
let pool: Pool | null = null
const db = () => pool ??= new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
test.afterAll(async () => { await pool?.end() })

async function seed(page: Page) {
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  if (!cookie) throw new Error('需要已登录的页面。')
  const { rows: [session] } = await db().query<{ userId: string }>('SELECT "userId" FROM session WHERE token = $1', [decodeURIComponent(cookie.value).split('.')[0]])
  const { rows: [member] } = await db().query<{ workspaceId: string }>(`SELECT m."workspaceId" FROM mikka_workspace_members m JOIN mikka_workspaces w ON w.id = m."workspaceId"
    WHERE m."userId" = $1 AND m.status = 'active' AND w.kind = 'team' LIMIT 1`, [session.userId])
  const connection = randomUUID()
  await db().query(`INSERT INTO byos_connections (id, "ownerId", "workspaceId", provider, state, epoch, "secretName", "secretDigest", "providerSubject")
    VALUES ($1, $2, $3, 'claude', 'connected', 1, $4, $5, 'e2e-subject')`, [connection, session.userId, member.workspaceId, `e2e-fixture-${connection}`, 'a'.repeat(64)])
  for (const model of ['e2e-opus-reported', 'e2e-sonnet-reported']) await db().query(`INSERT INTO byos_bindings (id, "ownerId", "workspaceId", "consumerId", "connectionId", "connectionRevision", route, "modelId")
    VALUES ($1, $2, $3, 'e2e-catalogue', $4, 1, 'claude_cpa', $5)`, [randomUUID(), session.userId, member.workspaceId, connection, model])
  // A computer that takes part, Claude Code installed and no models reported (as in production 2026-11-02), its Mikka
  // too old to take a subscription run (no subscriptionBroker) until `brokerReady` below.
  const device = randomUUID()
  await db().query(`INSERT INTO devices (id, "ownerId", name, kind, enabled, "deviceType", "lastSeenAt", harnesses) VALUES ($1, $2, 'E2E MacBook', 'local', true, 'laptop', now() + interval '1 hour', $3)`,
    [device, session.userId, JSON.stringify([{ harness: 'claude_code', installed: true, version: '2.1.309' }])])
  return device
}

/** The computer's Mikka now takes subscription runs; still no models reported. */
async function brokerReady(device: string) {
  await db().query(`UPDATE devices SET harnesses = $2 WHERE id = $1`, [device, JSON.stringify([{ harness: 'claude_code', installed: true, version: '2.1.309', subscriptionBroker: true }])])
}

/** A server of the same person that takes part and runs Claude Code subscription runs. */
async function addServer(device: string) {
  await db().query(`INSERT INTO devices (id, "ownerId", name, kind, enabled, "deviceType", "lastSeenAt", harnesses) SELECT $1, "ownerId", 'E2E Server', 'local', true, 'server', now() + interval '1 hour', $3 FROM devices WHERE id = $2`,
    [randomUUID(), device, JSON.stringify([{ harness: 'claude_code', installed: true, version: '2.1.309', subscriptionBroker: true }])])
}

test('模型与订阅：默认顺序来自已有订阅，添加、键盘排序、移除确认、运行位置都会保存', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await registerInTeam(page, '/settings?section=models')
  await expect(page.getByRole('heading', { level: 1, name: '模型与订阅' })).toBeVisible()
  const device = await seed(page)
  await page.reload()

  const list = page.getByRole('list', { name: '允许使用的模型' })
  // Untouched: Claude Code's opus from the connected account. The only computer cannot take a subscription run: the row names it and why.
  await expect(list.getByRole('listitem')).toHaveCount(1)
  const opus = list.getByRole('listitem').filter({ hasText: 'e2e-opus-reported' })
  await expect(opus).toContainText('Claude Code · Claude 订阅')
  await expect(opus.getByRole('status')).toHaveText('E2E MacBook 的 Mikka 需要更新')
  await attachLightDark(page, testInfo, 'model-order-needs-update')
  // Its Mikka updated: the subscription's model runs there, though its CLI reported no models.
  await brokerReady(device)
  await page.reload()
  await expect(opus.getByRole('status')).toHaveText('可用')
  await expect(page.getByRole('radio', { name: '本地' }).or(page.getByRole('button', { name: '本地' }))).toHaveAttribute('aria-pressed', 'true')
  // 会先用: the device a new run would go to now.
  await expect(page.getByText('1 台电脑参与调度 · 会先用 E2E MacBook', { exact: true })).toBeVisible()
  // A server that takes part goes before the computer.
  await addServer(device)
  await page.reload()
  await expect(page.getByText('2 台电脑参与调度 · 会先用 E2E Server', { exact: true })).toBeVisible()

  // 添加模型: only what the account lists; the one in the list is marked 已添加.
  await page.getByRole('button', { name: '添加模型', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加模型' })
  await expect(dialog.getByRole('checkbox')).toHaveCount(2)
  await expect(dialog.getByText('已添加', { exact: true })).toHaveCount(1)
  await dialog.getByRole('checkbox', { checked: false }).check()
  await dialog.getByRole('button', { name: '添加 1 个', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(list.getByRole('listitem')).toHaveCount(2)
  const sonnet = list.getByRole('listitem').filter({ hasText: 'e2e-sonnet-reported' })
  // A subscription's model needs no report from the computer's CLI.
  await expect(sonnet.getByRole('status')).toHaveText('可用')
  await attachLightDark(page, testInfo, 'model-order-list')

  // Keyboard: Space picks the row up, ArrowUp moves it, Space drops it; the order is saved.
  const handle = sonnet.getByRole('button', { name: /^拖动 e2e-sonnet-reported/ })
  // Rows are locked while a save is in flight; the add just saved.
  await expect(handle).toHaveAttribute('aria-disabled', 'false')
  await handle.focus()
  await page.keyboard.press('Space')
  await expect(handle).toHaveAttribute('data-dragging', 'true')
  // The live region says where the row is; wait for it before the next key, as a screen reader user hears it.
  const live = page.locator('[aria-live="assertive"]').first()
  await expect(live).toContainText('第 2 个')
  await page.keyboard.press('ArrowUp')
  await expect(live).toContainText('e2e-sonnet-reported 移到第 1 个')
  await page.keyboard.press('Space')
  await expect(live).toContainText('e2e-sonnet-reported 放在第 1 个')
  await expect(list.getByRole('listitem').first()).toContainText('e2e-sonnet-reported')
  await page.reload()
  await expect(list.getByRole('listitem').first()).toContainText('e2e-sonnet-reported')
  // 下移 from the row menu puts it back.
  await list.getByRole('listitem').first().getByRole('button', { name: 'e2e-sonnet-reported 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '下移' }).click()
  await expect(list.getByRole('listitem').first()).toContainText('e2e-opus-reported')

  // 移除 asks first.
  await list.getByRole('listitem').last().getByRole('button', { name: 'e2e-sonnet-reported 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '移除' }).click()
  const confirm = page.getByRole('alertdialog', { name: '移除 e2e-sonnet-reported？' })
  await confirm.getByRole('button', { name: '移除', exact: true }).click()
  await expect(list.getByRole('listitem')).toHaveCount(1)

  // 运行位置 云端 saves; without an E2B key the line says so.
  await page.getByRole('radio', { name: '云端' }).or(page.getByRole('button', { name: '云端' })).click()
  await expect(page.getByText('E2B Key 未设置', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('radio', { name: '云端' }).or(page.getByRole('button', { name: '云端' }))).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('alert').filter({ hasText: '重试' })).toHaveCount(0)
  await attachLightDark(page, testInfo, 'model-order-cloud')
})
