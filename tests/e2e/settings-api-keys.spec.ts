import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { Pool } from 'pg'
import type { AddressInfo } from 'node:net'
import { test, expect, registerInTeam } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// 「模型与订阅」 (orchestration.md § 1, C22): a custom provider is checked against
// its /models list before it is saved, shown by its last four characters only,
// shared with the team after a confirmation, and deleted. The provider is a
// local OpenAI-compatible server; playwright.config.ts lets the app reach
// loopback for it (MIKKA_MODEL_KEY_LOOPBACK).
const GOOD = `test-${Date.now()}-good-k3y9`
let server: Server
let baseUrl = ''
/** What the provider's /models answers next: its model ids, or down (503). */
let listed: string[] | 'down' = ['e2e-large', 'e2e-small']

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/v1/models') { response.writeHead(404).end(); return }
    if (request.headers.authorization !== `Bearer ${GOOD}`) { response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid"}'); return }
    if (listed === 'down') { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: listed.map(id => ({ id, object: 'model' })) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)) })

test('模型与订阅：添加自定义服务商、校验失败、分享给团队成员、删除', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await registerInTeam(page, '/settings?section=models')
  await expect(page.getByRole('heading', { level: 1, name: '模型与订阅' })).toBeVisible()
  const fallback = page.getByRole('switch', { name: '订阅额度用完后，自动改用 API Key', exact: true })
  await expect(fallback).toBeChecked()
  await expect(page.getByText('会按 API 服务商的价格计费', { exact: true })).toBeVisible()
  // Subscriptions and API keys are two groups (decision 2026-11-02-1200); 添加 API Key belongs to the second.
  const subscriptions = page.getByRole('region', { name: '模型订阅', exact: true })
  const apiKeys = page.getByRole('region', { name: 'API Key', exact: true })
  await expect(subscriptions).toBeVisible()
  await expect(apiKeys.getByText('还没有 API Key', { exact: true })).toBeVisible()
  await expect(apiKeys.getByRole('button', { name: '添加 API Key', exact: true })).toBeVisible()
  await attachLightDark(page, testInfo, 'api-keys-empty')

  // A wrong key is refused by the provider and nothing is saved.
  await page.getByRole('button', { name: '添加 API Key', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加 API Key' })
  // Presets take only the key; each says which Agents it runs on. DeepSeek and Kimi speak both protocols (Harness draft).
  const providerList = dialog.getByRole('radiogroup', { name: '服务商' })
  const providerRow = (name: string) => providerList.locator('label').filter({ has: page.getByText(name, { exact: true }) })
  await expect(providerRow('Anthropic')).toContainText('Anthropic 协议 · 可用 Claude Code')
  await expect(providerRow('OpenAI')).toContainText('OpenAI 协议 · 可用 Codex')
  await expect(providerRow('DeepSeek')).toContainText('Anthropic、OpenAI 协议 · 可用 Claude Code、Codex')
  await expect(providerRow('Kimi')).toContainText('Anthropic、OpenAI 协议 · 可用 Claude Code、Codex')
  await expect(providerRow('自定义服务商')).toContainText('选了协议才知道能用哪个 Agent')
  await providerList.getByRole('radio', { name: /DeepSeek/ }).check()
  await expect(dialog.getByText('协议', { exact: true })).toHaveCount(0)
  await attachLightDark(page, testInfo, 'api-keys-add-preset')
  // Only a custom provider picks its protocol; the options name the Agent.
  await providerList.getByRole('radio', { name: /自定义服务商/ }).check()
  await dialog.getByRole('textbox', { name: '名称' }).fill('E2E 网关')
  await dialog.getByRole('textbox', { name: 'Base URL' }).fill(baseUrl)
  const protocols = dialog.getByRole('group', { name: '协议' })
  await expect(protocols.getByRole('button', { name: 'OpenAI 协议 · 可用 Codex' }).or(protocols.getByRole('radio', { name: 'OpenAI 协议 · 可用 Codex' }))).toHaveAttribute('aria-pressed', 'true')
  await expect(protocols.getByText('Anthropic 协议 · 可用 Claude Code', { exact: true })).toBeVisible()
  await dialog.getByLabel('API Key').fill(`test-${Date.now()}-wrong`)
  await dialog.getByRole('button', { name: '添加', exact: true }).click()
  await expect(dialog.getByText('Key 无效或已被撤销。', { exact: true })).toBeVisible()
  await attachLightDark(page, testInfo, 'api-keys-invalid')

  await dialog.getByLabel('API Key').fill(GOOD)
  await dialog.getByRole('button', { name: '添加', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const host = new URL(baseUrl).host
  await expect(apiKeys.getByText(`${host} · ••••k3y9 · OpenAI 协议 · 可用 Codex`, { exact: true })).toBeVisible()
  await expect(subscriptions.getByText(`${host} · ••••k3y9`, { exact: false })).toHaveCount(0)
  expect(await page.content()).not.toContain(GOOD)
  // The row counts what the provider's /models gave.
  await expect(apiKeys.getByRole('status').filter({ hasText: '2 个模型' })).toBeVisible()
  // 允许使用的模型 offers the new key's models at once, without a reload.
  await page.getByRole('button', { name: '添加模型', exact: true }).click()
  const addModels = page.getByRole('dialog', { name: '添加模型' })
  await expect(addModels.getByText('e2e-large', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(addModels).toHaveCount(0)

  // 重新获取模型: a failed ask says why on the row; the next good one replaces the list.
  const refetch = apiKeys.getByRole('button', { name: '重新获取 E2E 网关 的模型', exact: true })
  listed = 'down'
  await refetch.click()
  await expect(apiKeys.getByRole('status').filter({ hasText: '无法获取模型 · 服务商没有响应' })).toBeVisible()
  await attachLightDark(page, testInfo, 'api-keys-models-failed')
  listed = ['e2e-large', 'e2e-small', 'e2e-new']
  await refetch.click()
  await expect(apiKeys.getByRole('status').filter({ hasText: '3 个模型' })).toBeVisible()
  await expect(apiKeys.getByText('无法获取模型', { exact: false })).toHaveCount(0)

  // 分享给团队成员 asks first; the first line says whose bill pays.
  const share = page.getByRole('switch', { name: '分享 E2E 网关 给团队成员', exact: true })
  await expect(share).not.toBeChecked()
  await share.click()
  const confirm = page.getByRole('alertdialog', { name: '分享 E2E 网关 给团队成员？' })
  await expect(confirm.getByRole('listitem').first()).toHaveText('团队成员可以用它跑自己的 Bot，用量算在你的 API 账单上。')
  await attachLightDark(page, testInfo, 'api-keys-share-confirm')
  await confirm.getByRole('button', { name: '分享', exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect(share).toBeChecked()
  await page.reload()
  await expect(page.getByRole('switch', { name: '分享 E2E 网关 给团队成员', exact: true })).toBeChecked()
  await attachLightDark(page, testInfo, 'api-keys-list')

  // The fallback switch saves.
  await fallback.click()
  await expect(fallback).not.toBeChecked()
  await page.reload()
  await expect(page.getByRole('switch', { name: '订阅额度用完后，自动改用 API Key', exact: true })).not.toBeChecked()

  await page.getByRole('button', { name: '删除 E2E 网关', exact: true }).click()
  const remove = page.getByRole('alertdialog', { name: '删除 E2E 网关？' })
  await remove.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText(`${host} · ••••k3y9`, { exact: false })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: '模型与订阅' })).toBeVisible()
  await expect(page.getByRole('switch', { name: '分享 E2E 网关 给团队成员', exact: true })).toHaveCount(0)
})

// A DeepSeek key serves both Agents: its row says so, and 添加模型 lists each of its models once per Agent (model · Agent).
// The key row is seeded (the real DeepSeek API is never called); its sealed value is never opened here.
test('模型与订阅：DeepSeek 的 Key 两种 Agent 都能用', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await registerInTeam(page, '/settings?section=models')
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
  try {
    const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))!
    const { rows: [session] } = await pool.query<{ userId: string }>('SELECT "userId" FROM session WHERE token = $1', [decodeURIComponent(cookie.value).split('.')[0]])
    await pool.query(`INSERT INTO model_api_keys (id,"ownerId",provider,protocol,ciphertext,iv,"keyVersion",last4,models) VALUES ($1,$2,'deepseek','anthropic','e2e-sealed','e2e-iv',1,'a1b2',$3::jsonb)`,
      [randomUUID(), session.userId, JSON.stringify(['e2e-deepseek-flash'])])
  } finally { await pool.end() }
  await page.reload()
  const apiKeys = page.getByRole('region', { name: 'API Key', exact: true })
  await expect(apiKeys.getByText('API Key · ••••a1b2 · Anthropic、OpenAI 协议 · 可用 Claude Code、Codex', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '添加模型', exact: true }).click()
  const addModels = page.getByRole('dialog', { name: '添加模型' })
  const rows = addModels.locator('label').filter({ hasText: 'e2e-deepseek-flash' })
  await expect(rows).toHaveCount(2)
  // An untouched list already has it on Claude Code (the default Agent); the Codex row can still be added.
  await expect(rows.nth(0)).toContainText('Claude Code')
  await expect(rows.nth(0)).toContainText('已添加')
  await expect(rows.nth(1)).toContainText('Codex')
  await expect(rows.nth(1).getByRole('checkbox')).toBeEnabled()
  await attachLightDark(page, testInfo, 'api-keys-deepseek-models')
})
