import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { splitBrowserNotes } from '../../lib/browser/note'
import { test, expect, register, app, browserClientHeaders } from './fixtures'

// The app-wide browser (Figma 412:8066): the top bar's globe opens it in place
// of the right panel, and a note pinned on a page waits in the chat composer
// as a removable chip.
test('The globe opens the browser in place of the right panel; notes on a page go into the chat composer', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)

  const globe = page.getByRole('button', { name: '浏览器', exact: true })
  await expect(globe).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('complementary', { name: '右栏', exact: true })).toBeVisible()

  await globe.click()
  await expect(globe).toHaveAttribute('aria-pressed', 'true')
  const browser = page.getByRole('complementary', { name: '浏览器', exact: true })
  await expect(browser).toBeVisible()
  await expect(page.getByRole('complementary', { name: '右栏', exact: true })).toHaveCount(0)
  const composer = page.getByRole('textbox', { name: '给 Coordinator 发消息' })
  await expect(composer).toBeVisible()

  // A page of the app's own origin can be reached, so an element can be picked.
  const address = browser.getByRole('textbox', { name: '地址', exact: true })
  await address.fill(app('/forgot-password'))
  await address.press('Enter')
  const pick = browser.getByRole('button', { name: '选择元素', exact: true })
  await expect(pick).toBeEnabled()
  await pick.click()
  await expect(pick).toHaveAttribute('aria-pressed', 'true')
  const frame = browser.frameLocator('iframe[title="网页"]')
  await frame.getByRole('button').first().click()
  const note = browser.getByRole('textbox', { name: /^给 .+ 写备注$/ })
  await note.fill('按钮文案改成发送')
  await note.press('Enter')
  const chips = page.locator('[data-slot="browser-note-chip"]')
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toHaveText('1 · 重置密码 · 发送重置链接 · 按钮文案改成发送')
  await testInfo.attach('element-note', { body: await page.screenshot(), contentType: 'image/png' })

  // Another origin is closed to the app: the same button drags a box, and the note has only the URL.
  // A stand-in for another site, so the test does not depend on the network.
  await page.context().route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Pricing</h1>' }))
  await address.fill('example.com/pricing')
  await address.press('Enter')
  await expect(address).toHaveValue('https://example.com/pricing')
  await expect(browser.getByRole('button', { name: '框选区域' })).toHaveCount(0)
  await expect(browser.getByRole('button', { name: '在新标签页打开' })).toHaveCount(0)
  await pick.click()
  await expect(pick).toHaveAttribute('aria-pressed', 'true')
  const stage = browser.locator('[data-slot="browser-stage"]')
  const box = (await stage.boundingBox())!
  await page.mouse.move(box.x + 40, box.y + 40)
  await page.mouse.down()
  await page.mouse.move(box.x + 240, box.y + 160, { steps: 4 })
  await page.mouse.up()
  await browser.getByRole('textbox', { name: '给 example.com/pricing 写备注', exact: true }).fill('价格不对')
  await browser.getByRole('button', { name: '放进对话', exact: true }).click()
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(1)).toHaveText('2 · example.com/pricing · 价格不对')
  await testInfo.attach('region-note', { body: await page.screenshot(), contentType: 'image/png' })

  const message = `浏览器备注验收 ${randomUUID()}`
  const storedResponse = Promise.withResolvers<void>()
  const releaseResponse = Promise.withResolvers<void>()
  await page.route('**/*', async route => {
    const request = route.request()
    if (request.method() !== 'POST' || !request.headers()['next-action'] || !request.postData()?.includes(message)) return route.fallback()
    // Let the actual action commit. Delay only delivery of its response to reproduce a send in flight.
    const response = await route.fetch()
    storedResponse.resolve()
    await releaseResponse.promise
    await route.fulfill({ response })
  })
  await composer.fill(message)
  await composer.press('Enter')
  try {
    await storedResponse.promise
    await page.getByRole('button', { name: '移除备注 2', exact: true }).click()
    await pick.click()
    const currentBox = (await stage.boundingBox())!
    await page.mouse.move(currentBox.x + 45, currentBox.y + 45)
    await page.mouse.down()
    await page.mouse.move(currentBox.x + 245, currentBox.y + 165, { steps: 4 })
    await page.mouse.up()
    await browser.getByRole('textbox', { name: '给 example.com/pricing 写备注', exact: true }).fill('发送期间的新备注')
    await browser.getByRole('button', { name: '放进对话', exact: true }).click()
  } finally { releaseResponse.resolve() }
  await expect(composer).toBeEnabled()
  await expect(chips).toHaveCount(1)
  await expect(chips).toHaveText('3 · example.com/pricing · 发送期间的新备注')
  await expect(page.locator('[data-slot="browser-note"]')).toHaveText(['1 · 重置密码 · 发送重置链接 · 按钮文案改成发送', '2 · example.com/pricing · 价格不对'])

  // Real server action, authenticated session and PostgreSQL event. No model or provider call is required to persist a person's note.
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Browser note acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to read a business database')
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const { rows: [owner] } = await pool.query('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows } = await pool.query(`SELECT "userId", "botId", payload FROM coordinator_events WHERE "userId" = $1 AND kind = $2 AND payload->>'text' LIKE $3`, [owner.id, 'user_message', `%${message}`])
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(owner.id)
    expect(rows[0].botId).toBeNull()
    const stored = splitBrowserNotes(rows[0].payload.text)
    expect(stored.text).toBe(message)
    expect(stored.notes.map(note => note.n)).toEqual([1, 2])
    expect(stored.notes[1]).toMatchObject({ n: 2, kind: 'region', url: 'https://example.com/pricing', note: '价格不对' })
  } finally { await pool.end() }
  await page.reload()
  await expect(page.locator('[data-slot="browser-note"]')).toHaveText(['1 · 重置密码 · 发送重置链接 · 按钮文案改成发送', '2 · example.com/pricing · 价格不对'])
  await expect(page.locator('[data-slot="bubble-content"]').filter({ hasText: message })).toBeVisible()

  // An independently registered owner must not receive the first owner's note on the real chat read path.
  const foreign = await page.context().browser()!.newContext({ baseURL: new URL(page.url()).origin, locale: 'zh-CN', extraHTTPHeaders: browserClientHeaders() })
  try {
    const other = await foreign.newPage()
    await register(other)
    await expect(other.getByRole('textbox', { name: '给 Coordinator 发消息' })).toBeVisible()
    await expect(other.locator('[data-slot="browser-note"]')).toHaveCount(0)
    await expect(other.getByText(message, { exact: true })).toHaveCount(0)
  } finally { await foreign.close() }

  await browser.getByRole('button', { name: '关闭浏览器', exact: true }).click()
  await expect(globe).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('complementary', { name: '右栏', exact: true })).toBeVisible()
})
