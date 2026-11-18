import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { test, expect, register } from './fixtures'

// Real compiled official UI and server actions against an isolated PostgreSQL.
// Only the provider's catalogue is synthetic; this is not a provider OAuth test.
let pool: Pool | null = null
const db = () => pool ??= new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
test.afterAll(async () => { await pool?.end() })

test('Capy settings hierarchy keeps connected credentials truthful and saves the real model controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 })
  const { email } = await register(page, '/settings?section=models')
  await expect(page.getByRole('heading', { level: 1, name: '模型与订阅', exact: true })).toBeVisible()
  const { rows: [owner] } = await db().query('SELECT id FROM "user" WHERE email=$1', [email])
  const { rows: [workspace] } = await db().query('SELECT id FROM mikka_workspaces WHERE "ownerId"=$1 AND kind=\'personal\'', [owner.id])
  const connection = randomUUID()
  await db().query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","accountLabel")
    VALUES ($1,$2,$3,'claude','connected',1,$4,$5,'settings-fixture','settings-fixture@example.com')`, [connection, owner.id, workspace.id, `e2e-fixture-${connection}`, 'a'.repeat(64)])
  await page.reload()
  await expect(page.getByText('settings-fixture@example.com', { exact: true })).toBeVisible()
  await expect(page.getByText('已连接的订阅或 API Key 还没有返回模型', { exact: true })).toBeVisible()
  await expect(page.getByText('还没有订阅或 API Key', { exact: true })).toHaveCount(0)
  const headings = await page.locator('.ui-sm h2').allTextContents()
  expect(headings.indexOf('模型订阅')).toBeLessThan(headings.indexOf('API Key'))
  expect(headings.indexOf('API Key')).toBeLessThan(headings.indexOf('优先使用的模型'))
  expect(headings.indexOf('优先使用的模型')).toBeLessThan(headings.indexOf('模型'))
  await expect(page.locator('.ui-sm-pick')).toHaveCount(0)
  const filter = page.getByRole('radiogroup', { name: '筛选模型' })
  await filter.getByRole('radio', { name: 'API Key', exact: true }).click()
  await expect(page.getByText('还没有添加 API Key', { exact: true })).toBeVisible()
  await expect(page.getByText('还没有订阅或 API Key', { exact: true })).toHaveCount(0)
  await filter.getByRole('radio', { name: '全部', exact: true }).click()
  await expect(page.getByText('需要先添加支持同一模型的 API Key，才会按服务商价格继续运行', { exact: true })).toBeVisible()
  const fallback = page.getByRole('switch', { name: '订阅额度用完后，自动改用 API Key', exact: true })
  const before = await fallback.getAttribute('aria-checked')
  await fallback.click()
  await expect(fallback).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true')
  await expect.poll(async () => (await db().query('SELECT "apiKeyAfterQuota" FROM "user" WHERE id=$1', [owner.id])).rows[0].apiKeyAfterQuota).toBe(before !== 'true')
  await page.reload()
  await expect(fallback).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true')

  const evidence = resolve('.hosted-ui/evidence/settings-capy')
  await mkdir(evidence, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.screenshot({ path: resolve(evidence, `connected-no-models-${scheme}.png`), fullPage: true })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await db().query('UPDATE byos_connections SET "modelCatalog"=$2::jsonb WHERE id=$1', [connection, JSON.stringify({ models: ['settings-fixture-model'], refreshedAt: new Date().toISOString() })])
  await page.reload()
  const model = page.getByRole('switch', { name: 'settings-fixture-model', exact: true })
  await expect(model).toBeVisible()
  await expect(model).toHaveAttribute('aria-checked', 'true')
  await model.click()
  await expect(model).toHaveAttribute('aria-checked', 'false')
  await expect.poll(async () => (await db().query('SELECT "modelSettings" FROM byos_connections WHERE id=$1', [connection])).rows[0].modelSettings?.models?.['settings-fixture-model']?.enabled).toBe(false)
  await page.reload()
  await expect(model).toHaveAttribute('aria-checked', 'false')
  await model.click()
  await expect(model).toHaveAttribute('aria-checked', 'true')
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.screenshot({ path: resolve(evidence, `model-controls-${scheme}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.getByRole('heading', { level: 1, name: '模型与订阅', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: resolve(evidence, 'model-controls-mobile-dark.png'), fullPage: true })
  await testInfo.attach('source-and-scope', { body: 'Official public+private production build; local synthetic account and provider catalogue; real PostgreSQL writes and remounts. No provider authentication or paid model call.', contentType: 'text/plain' })
})
