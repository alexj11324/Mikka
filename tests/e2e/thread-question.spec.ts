import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Pool } from 'pg'
import { test, expect, register, seedTask, openIssueFromSearch } from './fixtures'

function isolatedUrl() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Thread question acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return connectionString
}

function isolatedPool() {
  return new Pool({ connectionString: isolatedUrl(), max: 1 })
}

async function shoot(page: import('@playwright/test').Page, testInfo: import('@playwright/test').TestInfo, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    const path = testInfo.outputPath(`${name}-${scheme}.png`)
    await page.screenshot({ path })
    await testInfo.attach(`${name}-${scheme}`, { path, contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

const question = '首页大图换成 AVIF 能省 1.6 MB。Safari 15 以下不支持 AVIF，给它退回 JPEG，可以吗？'

// Same host dispatch + question record as the HTTP question probe; only the stopped hand-in is synthetic.
function seedQuestion(email: string, title: string, prompt: string) {
  const url = isolatedUrl()
  const seeded = spawnSync(process.execPath, ['--import', './tests/support/server-only.mjs', '--import', 'tsx', 'tests/e2e/support/seed-thread-question.ts', email, title, prompt, question], {
    encoding: 'utf8', env: { ...process.env, DATABASE_URL: url, MIKKA_DATABASE_URL: url },
  })
  if (seeded.status !== 0) throw new Error(`Question seed failed: ${seeded.stderr.slice(-2000)}`)
  return JSON.parse(seeded.stdout) as { runId: string; questionId: string }
}

async function questionStatus(id: string) {
  const pool = isolatedPool()
  try { return (await pool.query<{ status: string }>('SELECT status FROM factory_questions WHERE id=$1', [id])).rows[0]?.status }
  finally { await pool.end() }
}

async function expireQuestion(id: string) {
  const pool = isolatedPool()
  try { await pool.query("UPDATE factory_questions SET status='expired',\"updatedAt\"=now() WHERE id=$1", [id]) }
  finally { await pool.end() }
}

test('a thread that stopped on a question waits for your reply and takes the answer', async ({ page }, testInfo) => {
  test.skip(process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED !== '1' || process.env.MIKKA_FACTORY_ROUTING_ENABLED !== '1', 'Factory questions are behind the lifecycle flags')
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  const title = `Thread question ${randomUUID()}`
  await seedTask(page, title)
  const waiting = seedQuestion(email, title, 'Speed up the home page')
  const late = seedQuestion(email, title, 'Too late to answer')
  await expireQuestion(late.questionId)
  await openIssueFromSearch(page, title)
  const threads = page.getByRole('region', { name: /^线程/ })
  const row = threads.getByRole('button', { name: '打开线程 Speed up the home page', exact: true })

  // 等你回复 (Figma 382:6469): list row and header read the same state; the composer stays, without a stop button.
  await expect(row.getByText('等你回复', { exact: true })).toBeVisible()
  await row.click()
  const panel = page.getByRole('region', { name: 'Speed up the home page', exact: true })
  await expect(panel.getByRole('img', { name: '等你回复' })).toBeVisible()
  await expect(panel.getByText('等你回复', { exact: true })).toBeVisible()
  const box = panel.getByRole('textbox', { name: '告诉 Question fixture 下一步做什么…' })
  await expect(box).toBeVisible()
  await expect(panel.getByRole('button', { name: /停止/ })).toHaveCount(0)
  await box.fill('可以，Safari 15 以下用 JPEG')
  const send = panel.getByRole('button', { name: '发送', exact: true })
  await expect(send).toBeEnabled()
  await shoot(page, testInfo, 'waiting')

  // Answering continues the original run: the question resumes, the badge goes, no second answer.
  await send.click()
  await expect.poll(() => questionStatus(waiting.questionId)).toBe('resuming')
  await expect(panel.getByText('没发出去，草稿还在')).toHaveCount(0)
  await expect(panel.getByText('等你回复', { exact: true })).toHaveCount(0)
  await expect(row.getByText('等你回复', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('textbox')).toBeVisible()
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: /停止/ })).toHaveCount(0)
  await shoot(page, testInfo, 'resuming')

  // An expired question takes no answer: an ordinary finished thread.
  await threads.getByRole('button', { name: '打开线程 Too late to answer', exact: true }).click()
  const expired = page.getByRole('region', { name: 'Too late to answer', exact: true })
  await expect(expired.getByRole('list', { name: '线程对话' })).toBeVisible()
  await expect(expired.getByText('等你回复', { exact: true })).toHaveCount(0)
  await expect(expired.getByRole('textbox')).toHaveCount(0)
  await shoot(page, testInfo, 'expired')
})
