import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register } from './fixtures'

// The right-panel redesign removes the old suggestions entry. It may ship only
// with the replacement rail page and its card action from the navigation slice.
test('suggestions remain reachable and actionable after the panel changes', async ({ page }) => {
  const { email } = await register(page)
  const subject = `Suggestion entry ${randomUUID().slice(0, 8)}`
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('This test requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const id = randomUUID()
    await pool.query('INSERT INTO suggestions (id, "userId", source, "externalId", action, title, shown, "decidedBy", "actionTitle", "occurredAt") VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, now())', [id, user.id, 'gmail', `e2e-${id}`, 'reply', subject, 'rule', `回复 ${subject}`])
  } finally { await pool.end() }

  await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '建议', exact: true }).click()
  await expect(page.getByRole('heading', { name: '建议', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '建议', exact: true })).toBeVisible()
  const card = page.locator('button[data-slot="suggestion-card"]').filter({ hasText: subject })
  await expect(card).toBeVisible()
  // CI has no Coordinator: a failed action must leave the suggestion intact.
  await card.click()
  await expect(page.getByRole('alert').filter({ hasText: 'Coordinator 现在不可用' })).toBeVisible()
  await expect(card).toBeVisible()
})
