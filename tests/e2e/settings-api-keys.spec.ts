import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, registerInTeam } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// 「API 与订阅」 (orchestration.md § 1, C22): a custom provider is checked against
// its /models list before it is saved, shown by its last four characters only,
// shared with the team after a confirmation, and deleted. The provider is a
// local OpenAI-compatible server; playwright.config.ts lets the app reach
// loopback for it (MIKKA_MODEL_KEY_LOOPBACK).
const GOOD = `sk-e2e-${Date.now()}-good-k3y9`
let server: Server
let baseUrl = ''

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/v1/models') { response.writeHead(404).end(); return }
    if (request.headers.authorization !== `Bearer ${GOOD}`) { response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid"}'); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-large', object: 'model' }, { id: 'e2e-small', object: 'model' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)) })

test('API 与订阅：添加自定义服务商、校验失败、分享给团队成员、删除', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await registerInTeam(page, '/settings?section=models')
  await expect(page.getByRole('heading', { level: 1, name: 'API 与订阅' })).toBeVisible()
  const fallback = page.getByRole('switch', { name: '订阅额度用完后，自动改用 API Key', exact: true })
  await expect(fallback).toBeChecked()
  await expect(page.getByText('会按 API 服务商的价格计费', { exact: true })).toBeVisible()
  await attachLightDark(page, testInfo, 'api-keys-empty')

  // A wrong key is refused by the provider and nothing is saved.
  await page.getByRole('button', { name: '添加 API Key', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加 API Key' })
  await dialog.getByRole('combobox', { name: '服务商' }).click()
  await page.getByRole('option', { name: '自定义服务商' }).click()
  await dialog.getByRole('textbox', { name: '名称' }).fill('E2E 网关')
  await dialog.getByRole('textbox', { name: 'Base URL' }).fill(baseUrl)
  await expect(dialog.getByRole('combobox', { name: '协议' })).toHaveText('OpenAI 兼容')
  await dialog.getByLabel('API Key').fill('sk-e2e-wrong-key-0000')
  await dialog.getByRole('button', { name: '添加', exact: true }).click()
  await expect(dialog.getByText('Key 无效或已被撤销。', { exact: true })).toBeVisible()
  await attachLightDark(page, testInfo, 'api-keys-invalid')

  await dialog.getByLabel('API Key').fill(GOOD)
  await dialog.getByRole('button', { name: '添加', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const host = new URL(baseUrl).host
  await expect(page.getByText(`${host} · ••••k3y9`, { exact: true })).toBeVisible()
  expect(await page.content()).not.toContain(GOOD)

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
  await expect(page.getByText(`${host} · ••••k3y9`, { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'API 与订阅' })).toBeVisible()
  await expect(page.getByRole('switch', { name: '分享 E2E 网关 给团队成员', exact: true })).toHaveCount(0)
})
