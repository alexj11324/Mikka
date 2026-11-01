import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, seedTask, openIssueFromSearch } from './fixtures'

/**
 * A thread whose subscription ran out mid-run (lib/run-quota.ts, lib/run-quota-view.ts):
 * paused, it names the reset and offers 添加 API Key 继续 and 重置后重试 (not before the
 * reset); gone on on the person's key, it says so in one line.
 */

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Thread quota acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

const PROMPT = 'Route group replies'
const resetsAt = () => { const at = new Date(Date.now() + 3 * 3600_000); at.setMinutes(0, 0, 0); return at }

async function seed(email: string, title: string, state: 'paused' | 'switched') {
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, title])
    const agentId = randomUUID(), runId = randomUUID(), reset = resetsAt()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Thread agent'])
    const event = (kind: string, payload: object) => pool.query('INSERT INTO coordinator_events (id, "userId", kind, "dedupeKey", "issueId", "runId", payload, "deliveredAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now())',
      [randomUUID(), user.id, kind, `${kind}:${runId}`, issue.id, runId, JSON.stringify(payload)])
    if (state === 'paused') {
      await pool.query(`INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt, "pauseReason", "stopReason", "quotaResetsAt") VALUES ($1, $2, $3, $4, 'paused', $5, 'quota_exhausted', 'quota_exhausted', $6)`, [runId, user.id, issue.id, agentId, PROMPT, reset])
      await event('run_quota_paused', { reason: 'quota_exhausted', provider: 'codex', connectionId: null, resetsAt: reset.toISOString(), why: 'noApiKey', actions: [{ action: 'addApiKey' }, { action: 'retryAfterReset', at: reset.toISOString() }] })
    } else {
      const retryRunId = randomUUID()
      await pool.query(`INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt, "stopReason", "finishedAt") VALUES ($1, $2, $3, $4, 'failed', $5, 'quota_exhausted', now())`, [runId, user.id, issue.id, agentId, PROMPT])
      await pool.query(`INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt, "retryOf") VALUES ($1, $2, $3, $4, 'running', $5, $6)`, [retryRunId, user.id, issue.id, agentId, PROMPT, runId])
      await event('run_credential_switched', { reason: 'quota_exhausted', from: { kind: 'subscription', provider: 'codex', connectionId: null }, to: { kind: 'api_key', keyId: randomUUID(), provider: 'deepseek', name: null, last4: 'a1b2', model: 'deepseek-chat' }, retryRunId, resetsAt: reset.toISOString() })
    }
    await pool.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1, $2, 1, $3)', [randomUUID(), runId, JSON.stringify({ type: 'text-delta', id: runId, delta: 'Read the routing code; two handlers to change.' })])
  } finally {
    await pool.end()
  }
}

async function openThread(page: import('@playwright/test').Page, state: 'paused' | 'switched') {
  const { email } = await register(page)
  const title = `Thread quota ${randomUUID()}`
  await seedTask(page, title)
  await seed(email, title, state)
  await openIssueFromSearch(page, title)
  await page.getByRole('region', { name: /^线程/ }).getByRole('button', { name: `打开线程 ${PROMPT}`, exact: true }).click()
  return page.getByRole('region', { name: PROMPT, exact: true })
}

test('a thread paused on its subscription quota names the reset and offers the way on', async ({ page }) => {
  const panel = await openThread(page, 'paused')
  const card = panel.locator('[data-thread-quota-paused]')
  await expect(card).toContainText('ChatGPT 额度已用完 · ')
  await expect(card).toContainText('重置')
  await expect(card.getByRole('link', { name: '添加 API Key 继续', exact: true })).toBeVisible()
  // Before the reset the original subscription would only pause again.
  await expect(card.getByRole('button', { name: '重置后重试', exact: true })).toBeDisabled()
})

test('a thread that went on on the person\'s API key says so in one line', async ({ page }) => {
  const panel = await openThread(page, 'switched')
  await expect(panel.locator('[data-thread-quota-switch]')).toHaveText('ChatGPT 额度用完，已改用 DeepSeek API Key 继续（按 token 计费）')
  await expect(panel.locator('[data-thread-quota-paused]')).toHaveCount(0)
})
