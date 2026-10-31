import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect } from './accounts'
import { app, hydrated } from '../e2e/fixtures'
import { assertMvpEnvironment, MVP_SERVICES } from './isolated-env.mjs'
import { seedMvpSubscription } from './subscription.mjs'

assertMvpEnvironment()
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 })
test.afterAll(async () => { await pool.end() })

async function control(path: 'scenario' | 'state' | 'release', input: { marker: string; first?: string; last?: string }) {
  const response = await fetch(`${MVP_SERVICES}/streaming/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  })
  expect(response.ok).toBe(true)
  return response.json() as Promise<{ started: number; released: boolean }>
}

test('Coordinator streams before completion, resumes once and isolates bot and owner streams', { tag: '@smoke' }, async ({ page, request, testAccounts }, testInfo) => {
  const owner = testAccounts.scope.owner.userId
  await testAccounts.scope.assertActive()
  await seedMvpSubscription(pool, owner)
  const primary = { marker: `mvp-stream-${randomUUID()}`, first: `First ${randomUUID()}`, last: ' then complete.' }
  const botFirst = `Bot ${randomUUID()}`
  const botLast = 'OpenUI complete.'
  const secondary = { marker: `mvp-stream-${randomUUID()}`, first: `root = Stack([TextContent("${botFirst}"),`, last: `TextContent("${botLast}")])` }
  await control('scenario', primary)
  await control('scenario', secondary)
  const persisted = async (botId: string | null, text: string) => Number((await pool.query(
    `SELECT count(*) FROM coordinator_messages WHERE "userId"=$1 AND "botId" IS NOT DISTINCT FROM $2::uuid
      AND message->>'role'='assistant' AND message::text LIKE $3`, [owner, botId, `%${text}%`],
  )).rows[0].count)
  const holder = async (botId: string | null) => (await pool.query<{ leaseHolder: string | null }>(
    'SELECT "leaseHolder" FROM coordinator_sessions WHERE "userId"=$1 AND "botId" IS NOT DISTINCT FROM $2::uuid', [owner, botId],
  )).rows[0]?.leaseHolder
  const startedAt = new Date().toISOString()
  let botId: string | null = null
  try {
    await page.goto(app('/'))
    const name = `Stream Bot ${randomUUID().slice(0, 8)}`
    const bots = page.getByRole('list', { name: 'Bot', exact: true })
    await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: '新建 Bot', exact: true })
    await dialog.getByLabel('名字', { exact: true }).fill(name)
    await dialog.getByRole('button', { name: '创建', exact: true }).click()
    await expect(dialog).toBeHidden()
    botId = new URL(page.url()).searchParams.get('bot')
    expect(botId).toMatch(/^[a-f0-9-]{36}$/)
    await expect.poll(() => holder(botId)).toBeFalsy()

    await bots.getByRole('button', { name: /^Coordinator(?:，正在工作)?$/ }).click()
    const composer = page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })
    await hydrated(composer)
    await composer.fill(primary.marker)
    await composer.press('Enter')
    const live = page.locator('[data-coordinator-stream-id]').filter({ hasText: primary.first })
    await expect(live).toBeVisible()
    await expect(live).toHaveAttribute('data-streaming', 'true')
    expect(await control('state', primary)).toEqual({ started: 1, released: false })
    expect(await persisted(null, primary.first)).toBe(0)
    await expect(page.getByText(primary.last, { exact: false })).toHaveCount(0)
    const primaryRun = await holder(null)
    expect(primaryRun).toMatch(/^wrun_/)
    await testInfo.attach('01-partial-before-model-completion', { body: await page.screenshot({ mask: [page.locator('input'), page.locator('[data-slot="avatar"]')] }), contentType: 'image/png' })

    const streamPath = app(`/api/coordinator/stream?runId=${primaryRun}`)
    expect((await request.get(streamPath)).status()).toBe(401)
    expect((await testAccounts.scope.peer.request(streamPath)).status).toBe(204)
    expect((await testAccounts.scope.owner.request(app('/api/coordinator/stream?runId=wrun_wrong'))).status).toBe(204)
    // Cancel a real replay reader, then prove the producer and its durable lease survive.
    const replay = await page.evaluate(async ({ path, expected }) => {
      const response = await fetch(path)
      if (!response.ok || !response.body) throw new Error('Replay unavailable')
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let text = ''
      try {
        while (!text.includes(expected)) {
          const next = await reader.read()
          if (next.done) throw new Error('Replay ended before text')
          text += next.value
        }
      } finally { await reader.cancel() }
      return text
    }, { path: streamPath, expected: primary.first })
    expect(replay).toContain(primary.first)
    expect(await holder(null)).toBe(primaryRun)
    expect(await control('state', primary)).toEqual({ started: 1, released: false })

    await bots.getByRole('button', { name, exact: true }).click()
    const botChat = page.getByRole('region', { name: `与 ${name} 的对话`, exact: true })
    await expect(botChat.getByText(primary.first, { exact: false })).toHaveCount(0)
    const botComposer = page.getByRole('textbox', { name: `给 ${name} 发消息`, exact: true })
    await hydrated(botComposer)
    await botComposer.fill(secondary.marker)
    await botComposer.press('Enter')
    await expect(botChat.locator('[data-coordinator-stream-id]').filter({ hasText: botFirst })).toBeVisible()
    await expect(botChat.getByText(botLast, { exact: true })).toHaveCount(0)
    await expect(botChat).not.toContainText('root = Stack')
    await expect(botChat.getByText(primary.first, { exact: false })).toHaveCount(0)
    const botRun = await holder(botId)
    expect(botRun).toMatch(/^wrun_/)
    expect(botRun).not.toBe(primaryRun)
    expect((await testAccounts.scope.peer.request(app(`/api/coordinator/stream?botId=${botId}&runId=${botRun}`))).status).toBe(404)
    expect((await testAccounts.scope.owner.request(app(`/api/coordinator/stream?botId=${botId}&runId=${primaryRun}`))).status).toBe(204)
    await control('release', secondary)
    await expect(botChat.getByText(botFirst, { exact: true })).toHaveCount(1)
    await expect(botChat.getByText(botLast, { exact: true })).toBeVisible()
    await expect.poll(() => persisted(botId, botFirst)).toBe(1)

    await bots.getByRole('button', { name: /^Coordinator(?:，正在工作)?$/ }).click()
    await expect(live).toBeVisible()
    await page.reload()
    await expect(live).toHaveCount(1)
    await expect(live).toBeVisible()
    expect(await holder(null)).toBe(primaryRun)
    expect(await control('state', primary)).toEqual({ started: 1, released: false })
    expect(await persisted(null, primary.first)).toBe(0)
    await testInfo.attach('02-partial-replayed-after-refresh', { body: await page.screenshot({ mask: [page.locator('input'), page.locator('[data-slot="avatar"]')] }), contentType: 'image/png' })

    await control('release', primary)
    const chat = page.getByRole('region', { name: '与 Coordinator 的对话', exact: true })
    await expect(chat.getByText(primary.first + primary.last, { exact: true })).toHaveCount(1)
    await expect.poll(() => persisted(null, primary.first)).toBe(1)
    await expect(live).toHaveCount(0)
    expect(await persisted(null, botFirst)).toBe(0)
    expect(await persisted(botId, primary.first)).toBe(0)
    await testInfo.attach('03-persisted-once-after-stream', { body: await page.screenshot({ mask: [page.locator('input'), page.locator('[data-slot="avatar"]')] }), contentType: 'image/png' })
    await testInfo.attach('coordinator-streaming-evidence', { body: JSON.stringify({
      revision: process.env.MIKKA_TEST_DEPLOYMENT_SHA, environmentId: testAccounts.scope.lease.environmentId,
      startedAt, finishedAt: new Date().toISOString(), primaryRun, botRun, botId,
      boundary: 'Real app, authentication, PostgreSQL, Workflow and subscription worker; scripted model tail held by loopback MVP service',
      assertions: ['partial-before-finish', 'reader-cancel-keeps-producer', 'refresh-replays-once', 'partial-openui-without-source', 'bot-scope', 'owner-peer-anonymous-scope', 'committed-history-once'],
    }, null, 2), contentType: 'application/json' })
  } finally {
    await Promise.all([control('release', primary), control('release', secondary)])
  }
})
