import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, register } from './fixtures'

/**
 * A21–A23: an action that will touch the person's mail is shown as a card
 * with exactly what will be sent, and declining it must not report success.
 * Approving is not exercised here because it reaches Composio.
 */

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('E2E_DATABASE_URL is required.')
  return new Pool({ connectionString, max: 1 })
}

async function seedPendingEmail(page: Page) {
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  if (!cookie) throw new Error('seedPendingEmail needs a signed-in page.')
  const db = isolatedPool()
  try {
    const { rows: [session] } = await db.query<{ userId: string }>('SELECT "userId" FROM session WHERE token = $1', [decodeURIComponent(cookie.value).split('.')[0]])
    if (!session) throw new Error('No session row for the signed-in page.')
    const id = randomUUID()
    await db.query('INSERT INTO pending_actions (id, "userId", action, input, status) VALUES ($1, $2, $3, $4, $5)', [id, session.userId, 'send_email', JSON.stringify({ to: ['kevin@example.com'], subject: '十月账单', body: '请核对这张账单。' }), 'pending'])
    return { id, userId: session.userId }
  } finally {
    await db.end()
  }
}

async function actionStatus(id: string) {
  const db = isolatedPool()
  try {
    const { rows: [{ status }] } = await db.query<{ status: string }>('SELECT status FROM pending_actions WHERE id = $1', [id])
    return status
  } finally {
    await db.end()
  }
}

test('审批卡片显示将要发送的邮件，拒绝后不报成功', async ({ page }) => {
  await register(page)
  const { id } = await seedPendingEmail(page)
  await page.reload()

  const card = page.getByRole('list', { name: '等你确认', exact: true }).getByRole('listitem').first()
  await expect(card).toContainText('发送邮件')
  await expect(card).toContainText('kevin@example.com')
  await expect(card).toContainText('十月账单')
  await expect(card).toContainText('请核对这张账单。')

  await card.getByRole('button', { name: '不要', exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByText('邮件已发送', { exact: true })).toHaveCount(0)
  expect(await actionStatus(id)).toBe('declined')

  // A23: after a reload the decision is read back from the server, not replayed.
  await page.reload()
  await expect(page.getByRole('list', { name: '等你确认', exact: true })).toHaveCount(0)
  expect(await actionStatus(id)).toBe('declined')
})
