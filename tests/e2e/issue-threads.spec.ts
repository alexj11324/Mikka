import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, watchRuntime, seedTask, openIssueFromSearch, openSearch } from './fixtures'

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Issue thread acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

// This fixture only touches CI's isolated disposable database, never a Preview or production DB.
async function seedThreads(email: string, title: string) {
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, title])
    const agentId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Thread agent'])
    for (const [status, prompt, summary] of [['succeeded', 'Model the routing table', 'PR #95 merged'], ['running', 'Route group replies', null]] as const) {
      const runId = randomUUID()
      await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt, report) VALUES ($1, $2, $3, $4, $5, $6, $7)', [runId, user.id, issue.id, agentId, status, prompt, summary && JSON.stringify({ summary })])
      await pool.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1, $2, 1, $3)', [randomUUID(), runId, JSON.stringify({ type: 'text-delta', id: runId, delta: `Agent reply for ${prompt}` })])
    }
    return issue.id
  } finally { await pool.end() }
}

test('Issue threads open on the right as a conversation; comments are cards with replies inside', async ({ page, browser }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  const title = `Thread detail ${randomUUID()}`
  await seedTask(page, title)
  const issueId = await seedThreads(email, title)
  await openIssueFromSearch(page, title)
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title)
  const threads = page.getByRole('region', { name: /^线程/ })
  await expect(threads.getByRole('button', { name: /^打开线程 / })).toHaveCount(2)
  await expect(threads.getByText('PR #95 merged', { exact: true })).toBeVisible()
  // Activity records each dispatch as a plain row.
  const activity = page.getByRole('region', { name: '任务活动', exact: true })
  await expect(activity.getByText('派出线程')).toHaveCount(2)

  // This finished fixture lacks a repository and session, so it must not probe feedback eligibility.
  const feedbackRequests: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/api/self-improvement')) feedbackRequests.push(request.url()) })
  await page.route('**/api/self-improvement?runId=*', route => route.fulfill({ status: 500, body: 'Unexpected feedback probe' }))
  // A finished thread reads as a conversation and takes no message.
  await threads.getByRole('button', { name: '打开线程 Model the routing table', exact: true }).click()
  let panel = page.getByRole('region', { name: 'Model the routing table', exact: true })
  await expect(panel.getByRole('list', { name: '线程对话' })).toContainText('Agent reply for Model the routing table')
  await expect(panel.getByRole('textbox')).toHaveCount(0)
  expect(feedbackRequests).toEqual([])

  // A running thread ends in the composer; what is said there goes to the agent and stays in the thread.
  await threads.getByRole('button', { name: '打开线程 Route group replies', exact: true }).click()
  panel = page.getByRole('region', { name: 'Route group replies', exact: true })
  await panel.getByRole('textbox', { name: '告诉 Thread agent 下一步做什么…' }).fill('Check the fallback timer')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByRole('list', { name: '线程对话' })).toContainText('Check the fallback timer')
  expect(feedbackRequests).toEqual([])
  await testInfo.attach('thread-open', { body: await page.screenshot(), contentType: 'image/png' })
  await panel.getByRole('button', { name: '关闭线程', exact: true }).click()
  await expect(panel).toHaveCount(0)

  // Comments are cards; a reply is written inside the card.
  await activity.getByLabel('评论内容').fill('Ship it after e2e')
  await activity.getByRole('button', { name: '发送评论', exact: true }).click()
  const card = activity.getByRole('article', { name: /的评论$/ })
  await expect(card).toContainText('Ship it after e2e')
  await card.getByLabel('回复内容').fill('Agreed')
  await card.getByRole('button', { name: '发送回复', exact: true }).click()
  await expect(card).toContainText('Agreed')
  // Board navigation uses the existing document flush before unmounting the editor.
  await page.getByRole('navigation', { name: '当前位置', exact: true }).getByRole('button', { name: '看板', exact: true }).click()
  await openIssueFromSearch(page, title)
  await page.reload()
  await expect(page.getByRole('region', { name: '任务活动', exact: true }).getByRole('article', { name: /的评论$/ })).toContainText('Agreed')

  // A personal issue is the owner's alone (R-26): a legacy invitation doesn't reveal it or its threads.
  const colleague = await browser.newContext({ locale: 'zh-CN' })
  const colleagueErrors = watchRuntime(colleague)
  try {
    const teammatePage = await colleague.newPage()
    await teammatePage.setViewportSize({ width: 1440, height: 960 })
    const teammate = await register(teammatePage)
    const pool = isolatedPool()
    try {
      const { rows: [owner] } = await pool.query('SELECT id FROM "user" WHERE email=$1', [email])
      const { rows: [member] } = await pool.query('SELECT id FROM "user" WHERE email=$1', [teammate.email])
      await pool.query('INSERT INTO issue_members ("issueId","userId","memberId") VALUES ($1,$2,$3)', [issueId, owner.id, member.id])
    } finally { await pool.end() }
    await teammatePage.reload()
    const search = await openSearch(teammatePage)
    await search.getByRole('combobox', { name: '全局搜索', exact: true }).fill(title)
    await expect(search.getByText(/^没有匹配的(任务|结果)$/)).toBeVisible()
    await expect(search.getByRole('option').filter({ hasText: title })).toHaveCount(0)
    await expect(teammatePage.getByText('Route group replies')).toHaveCount(0)
    await expect(teammatePage.getByText('Agent reply', { exact: false })).toHaveCount(0)
  } finally {
    await colleague.close()
    expect(colleagueErrors).toEqual([])
  }
})

// Synthetic completed run exercises feedback UI and its real authenticated route in disposable CI.
test('eligible completed thread records the person’s feedback', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  const title = `Feedback thread ${randomUUID()}`
  await seedTask(page, title)
  const pool = isolatedPool()
  const runId = randomUUID(), deviceId = randomUUID(), repoId = randomUUID(), agentId = randomUUID()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId"=$1 AND title=$2', [user.id, title])
    await pool.query('INSERT INTO devices (id,"ownerId",name,enabled) VALUES ($1,$2,$3,true)', [deviceId, user.id, 'Feedback fixture'])
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,$4)', [repoId, deviceId, user.id, '/ci/feedback-fixture'])
    await pool.query('INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,$3,$4,$5)', [agentId, user.id, 'codex', 'Feedback agent', deviceId])
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,"sessionId","startedAt","finishedAt",report)
      VALUES ($1,$2,$3,$4,$5,$6,'succeeded','Review feedback fixture','fixture-session',now(),now(),$7)`, [runId, user.id, issue.id, agentId, deviceId, repoId, JSON.stringify({ summary: 'Fixture report' })])
    await openIssueFromSearch(page, title)
    await page.getByRole('button', { name: '打开线程 Review feedback fixture' }).click()
    const panel = page.getByRole('region', { name: 'Review feedback fixture', exact: true })
    await panel.getByRole('textbox', { name: '补充说明（可选）' }).fill('Please include the verification result')
    const feedback = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/self-improvement') && response.request().method() === 'POST')
    await panel.getByRole('button', { name: '需要改进' }).click()
    expect((await feedback).status()).toBe(200)
    await expect(panel.getByText('反馈已保存')).toBeVisible()
    const { rows } = await pool.query('SELECT verdict,note FROM improvement_feedback WHERE "userId"=$1 AND "runId"=$2', [user.id, runId])
    expect(rows).toEqual([{ verdict: 'negative', note: 'Please include the verification result' }])
  } finally { await pool.end() }
})
