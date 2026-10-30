import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, register, seedTask, openIssueFromSearch } from './fixtures'

/**
 * A stop the daemon never confirms. The request is seeded as older than the
 * 30-second deadline, so the panel must show the unconfirmed state at once
 * instead of pretending the thread stopped. A13: on a 320px screen the retry
 * target is at least 88×44, as the design requires.
 */

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Issue thread acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

async function seedUnconfirmedStop(email: string, title: string) {
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, title])
    const agentId = randomUUID()
    const runId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Thread agent'])
    await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt, "stopRequestedAt") VALUES ($1, $2, $3, $4, $5, $6, $7)', [runId, user.id, issue.id, agentId, 'running', 'Route group replies', new Date(Date.now() - 31_000)])
    await pool.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1, $2, 1, $3)', [randomUUID(), runId, JSON.stringify({ type: 'text-delta', id: runId, delta: 'Agent reply for Route group replies' })])
  } finally {
    await pool.end()
  }
}

async function openUnconfirmedThread(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 })
  const { email } = await register(page)
  const title = `Stop unconfirmed ${randomUUID()}`
  await seedTask(page, title)
  await seedUnconfirmedStop(email, title)
  await openIssueFromSearch(page, title)
  await page.getByRole('region', { name: /^线程/ }).getByRole('button', { name: '打开线程 Route group replies', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Route group replies', exact: true })
  await expect(panel.getByText('停止未确认', { exact: true })).toBeVisible()
  return panel
}

test('a stop the daemon never confirms says so instead of claiming success', async ({ page }) => {
  const panel = await openUnconfirmedThread(page, 1440)
  await expect(panel.getByRole('button', { name: '重试停止', exact: true })).toBeVisible()
  await expect(panel.getByText('已停止', { exact: true })).toHaveCount(0)
})

test('on a 320px screen the retry target is at least 88×44', async ({ page }) => {
  const panel = await openUnconfirmedThread(page, 320)
  const retry = panel.getByRole('button', { name: '重试停止', exact: true })
  await expect(retry).toBeVisible()
  const box = await retry.boundingBox()
  expect(box, 'retry button must be laid out').not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(88)
  expect(box!.height).toBeGreaterThanOrEqual(44)
})
