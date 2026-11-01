import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test as apiTest } from '@playwright/test'
import { test, expect, register, app } from './fixtures'

apiTest('both shared image GET paths retain auth and cross-site protection', async ({ request }) => {
  for (const path of ['/api/agent/images', '/api/agent']) {
    const anonymous = await request.get(app(`${path}?q=Public%20fixture`))
    expect(anonymous.status()).toBe(401)
    expect(anonymous.headers()['cache-control']).toBe('private, no-store')
    expect((await request.get(app(`${path}?q=Public%20fixture`), { headers: { 'sec-fetch-site': 'cross-site' } })).status()).toBe(403)
  }
})

test('a saved current Bot reply loads its image via the canonical GET without legacy generation', async ({ page }, info) => {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Requires disposable E2E database')
  const target = new URL(connectionString)
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' || target.hostname !== '127.0.0.1' || target.port !== '5432' || target.pathname !== '/mikka_e2e' || target.search) throw new Error('Only Actions loopback mikka_e2e fixture is allowed')
  const { email } = await register(page)
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    expect(user).toBeTruthy()
    await pool.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1, $2, (SELECT "botId" FROM coordinator_bots WHERE "ownerId" = $2), 1, $3)', [randomUUID(), user.id, JSON.stringify({ role: 'assistant', content: 'root = Stack([TextContent("已保存的 Bot 配图正文"), BeImage("Public fixture", "公开文档配图", "公开文档示例")])' })])
  } finally { await pool.end() }
  const image = { src: 'https://upload.wikimedia.org/controlled-fixture.png', width: 500, height: 300, title: 'Controlled fixture', source: 'https://commons.wikimedia.org/wiki/File:Fixture.png', author: 'Fixture', license: 'CC0' }
  const lookups: string[] = []
  const legacyRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === app('/api/agent')) legacyRequests.push(`${request.method()} ${request.url()}`)
  })
  await page.route('**/api/agent/images?q=*', route => {
    lookups.push(route.request().url())
    return route.fulfill({ json: { image } })
  })
  // Valid 1px RGBA PNG with checked chunk CRCs; the browser must decode it.
  await page.route(image.src, route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=', 'base64') }))
  await page.goto(app('/?section=coordinator'))
  const bot = page.getByRole('region', { name: 'Coordinator', exact: true })
  await expect(bot.getByText('已保存的 Bot 配图正文', { exact: true })).toBeVisible()
  await expect(bot.getByRole('img', { name: '公开文档配图', exact: true })).toBeVisible()
  await expect(bot.getByRole('img', { name: '公开文档配图', exact: true })).toHaveJSProperty('naturalWidth', 1)
  await expect(bot.getByRole('link', { name: /Wikimedia Commons.*Controlled fixture/ })).toBeVisible()
  expect(lookups).toHaveLength(1)
  expect(new URL(lookups[0]).searchParams.get('q')).toBe('Public fixture')
  expect(legacyRequests).toEqual([])
  await info.attach('current-bot-image-read', { body: JSON.stringify({ canonicalImageGET: lookups, legacyRequests, source: image.source, controlledTransports: true }), contentType: 'application/json' })
})
