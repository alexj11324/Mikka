import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { suggestionMessage } from '../../lib/suggestions/card'
import { test, expect, register, rail, seedSuggestion } from './fixtures'

// Writes one Coordinator message straight into CI's isolated disposable database: what a tapped card leaves in the chat.
async function seedSentCard(email: string, message: string, position = 1) {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('This test requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    await pool.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1, $2, (SELECT "botId" FROM coordinator_bots WHERE "ownerId" = $2), $4, $3)', [randomUUID(), user.id, JSON.stringify({ role: 'user', content: message }), position])
  } finally { await pool.end() }
}

test('建议：卡片列表与 Coordinator 对话各占一半；发出的卡片在对话里是同一张卡，只补原文和链接；Artifact 页可打开', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 940 })
  const { email } = await register(page)
  const subject = `周四的会 ${randomUUID().slice(0, 8)}`
  await seedSuggestion(page, { title: `Re: ${subject}`, actionTitle: `回复 Kevin 的 Gmail 邮件：${subject}` })
  await seedSentCard(email, suggestionMessage({ source: 'github', action: 'handle', title: 'PR 212 type check', actionTitle: '修复 PR #212 的类型检查', actor: 'Kevin', url: 'https://github.com/alexj11324/Mikka/pull/212' }))

  await rail(page, '建议').click()
  await expect(page.getByRole('heading', { name: '建议', exact: true })).toBeVisible()
  const card = page.locator('button[data-slot="suggestion-card"]').filter({ hasText: subject })
  await expect(card).toContainText('回复')
  await expect(card.locator('[data-slot="source-mention"]')).toHaveText('Gmail')
  // The mark keeps 4px off the words after it.
  expect(await card.locator('[data-slot="source-mention"]').evaluate(mention => parseFloat(getComputedStyle(mention).marginRight))).toBeGreaterThanOrEqual(4)

  const chat = page.getByRole('region', { name: 'Coordinator', exact: true })
  const sent = chat.locator('[data-slot="suggestion-card"]').filter({ hasText: 'PR #212 的类型检查' })
  await expect(sent).toContainText('修复')
  await expect(sent.locator('[data-slot="source-mention"]')).toHaveText('GitHub')
  await expect(chat.getByText('原文：「PR 212 type check」', { exact: true })).toBeVisible()
  await expect(chat.getByRole('link', { name: 'https://github.com/alexj11324/Mikka/pull/212' })).toBeVisible()
  await expect(chat.getByText('Kevin', { exact: true })).toHaveCount(0)

  // This environment runs no Coordinator: the tap says so, and the card stays in 建议.
  await card.click()
  await expect(page.getByRole('alert').filter({ hasText: 'Coordinator 现在不可用' })).toBeVisible()
  await expect(card).toBeVisible()

  await rail(page, 'Artifact').click()
  await expect(page.getByRole('heading', { name: 'Artifact', exact: true })).toBeVisible()
  await expect(page.getByText('还没有 Artifact', { exact: true })).toBeVisible()
  await expect(rail(page, 'Artifact')).toHaveAttribute('aria-current', 'page')
})

test('建议：一张卡里很长的不换行文字不会撑宽左栏，右边的 Coordinator 对话仍在屏幕内', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 940 })
  await register(page)
  // A made-up unbroken run, as long as the hidden metadata a deploy bot's comment can carry.
  const unbroken = `${randomUUID().replaceAll('-', '')}${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(30)}`
  await seedSuggestion(page, { source: 'github', title: unbroken })

  await rail(page, '建议').click()
  const card = page.locator('button[data-slot="suggestion-card"]').filter({ hasText: unbroken.slice(0, 32) })
  await expect(card).toBeVisible()
  const chat = page.getByRole('region', { name: 'Coordinator', exact: true })
  await expect(chat).toBeInViewport({ ratio: 1 })
  const list = page.locator('section[aria-labelledby="suggestions-title"]')
  const [listBox, chatBox] = await Promise.all([list.boundingBox(), page.locator('[data-slot="suggestions-coordinator"]').boundingBox()])
  // Half and half, give or take the rule between them.
  expect(Math.abs(listBox!.width - chatBox!.width)).toBeLessThanOrEqual(2)
  expect(chatBox!.x + chatBox!.width).toBeLessThanOrEqual(1440)
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('建议：一条以前存下的 GitHub 原文卡片发进 Coordinator 对话后，只显示可读的文字和链接，不显示机器人的元数据', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 940 })
  const { email } = await register(page)
  // Made-up hidden metadata in the shape a deploy bot leaves, stored raw as older rows were.
  const metadata = `[pv]: #${randomUUID().replaceAll('-', '')}${'QUJDREVGR0hJSktMTU5PUA'.repeat(6)}=:${'eyJmYWtlIjp0cnVlfQ'.repeat(6)}`
  const url = 'https://github.com/alexj11324/Mikka/pull/1#issuecomment-2'
  // The message as it was written before this fix: the raw title inside the card.
  await seedSentCard(email, `<suggestion source="github" action="reply" title="「${metadata}」" actor="「deploy-preview[bot]」" url="「${url}」"></suggestion>`)
  await seedSentCard(email, suggestionMessage({ source: 'github', action: 'reply', title: '#### ⚠️ Scanner found **1** secret', actionTitle: null, actor: 'scanner[bot]', url: null }), 2)

  await rail(page, '建议').click()
  const chat = page.getByRole('region', { name: 'Coordinator', exact: true })
  await expect(chat.getByRole('link', { name: url })).toBeVisible()
  await expect(chat.locator('[data-slot="suggestion-card"]').filter({ hasText: '⚠️ Scanner found 1 secret' })).toBeVisible()
  await expect(chat).not.toContainText('QUJDREVG')
  await expect(chat).not.toContainText('[pv]')
  await expect(chat).not.toContainText('####')
})
