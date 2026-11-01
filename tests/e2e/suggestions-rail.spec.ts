import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { suggestionMessage } from '../../lib/suggestions/card'
import { test, expect, register, rail, seedSuggestion } from './fixtures'

// Writes one Coordinator message straight into CI's isolated disposable database: what a tapped card leaves in the chat.
async function seedSentCard(email: string, message: string) {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('This test requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    await pool.query('INSERT INTO coordinator_messages (id, "userId", position, message) VALUES ($1, $2, 1, $3)', [randomUUID(), user.id, JSON.stringify({ role: 'user', content: message })])
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
