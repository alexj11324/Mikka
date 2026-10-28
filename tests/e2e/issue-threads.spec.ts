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

test('The owner stops a live thread from its composer; it reads 正在停止… until the run ends', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  const title = `Thread stop ${randomUUID()}`
  await seedTask(page, title)
  const pool = isolatedPool()
  const runs: Record<string, string> = {}
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, title])
    const agentId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Thread agent'])
    for (const [status, prompt] of [['waiting_input', 'Pick a cache key'], ['running', 'Trim the bundle']] as const) {
      runs[status] = randomUUID()
      await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt) VALUES ($1, $2, $3, $4, $5, $6)', [runs[status], user.id, issue.id, agentId, status, prompt])
    }
  } finally { await pool.end() }
  await openIssueFromSearch(page, title)
  const threads = page.getByRole('region', { name: /^线程/ })

  // Waiting for a reply is still live, so it can be stopped too.
  await threads.getByRole('button', { name: '打开线程 Pick a cache key', exact: true }).click()
  let panel = page.getByRole('region', { name: 'Pick a cache key', exact: true })
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeVisible()

  await threads.getByRole('button', { name: '打开线程 Trim the bundle', exact: true }).click()
  panel = page.getByRole('region', { name: 'Trim the bundle', exact: true })
  const composer = panel.getByRole('textbox', { name: '告诉 Thread agent 下一步做什么…' })
  const stop = panel.getByRole('button', { name: '停止', exact: true })
  // Typing turns stop into send; clearing the draft brings stop back.
  await composer.fill('Keep the polyfills')
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await expect(stop).toHaveCount(0)
  await composer.fill('')
  await expect(stop).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('thread-stop-running.png') })

  await page.clock.install()
  await stop.click()
  await expect(panel.getByText('正在停止…', { exact: true })).toBeVisible()
  await expect(threads.getByRole('button', { name: '打开线程 Trim the bundle', exact: true })).toContainText('正在停止…')
  await expect(stop).toHaveCount(0)
  await expect(composer).toBeEditable()
  await composer.fill('Keep this draft while stopping')
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  const check = isolatedPool()
  try {
    await expect.poll(async () => (await check.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id = $1', [runs.running])).rows[0].stopRequestedAt).not.toBeNull()
    const originalStop = (await check.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id = $1', [runs.running])).rows[0].stopRequestedAt
    await page.screenshot({ path: testInfo.outputPath('thread-stop-stopping.png') })
    // An offline daemon never acknowledges. The timeout unlocks retry, not the draft.
    await page.clock.fastForward(30_100)
    await expect(panel.getByRole('alert')).toContainText('没停下来，再试一次')
    await expect(composer).toHaveValue('Keep this draft while stopping')
    await expect(composer).toBeEditable()
    await page.screenshot({ path: testInfo.outputPath('thread-stop-timeout.png') })
    await panel.getByRole('button', { name: '重试', exact: true }).click()
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(composer).toHaveValue('Keep this draft while stopping')
    await expect(panel.getByText('正在停止…', { exact: true })).toBeVisible()
    expect((await check.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id = $1', [runs.running])).rows[0].stopRequestedAt).toEqual(originalStop)
    // The daemon ends the run: the thread shows it stopped and the composer goes away.
    await check.query('UPDATE agent_runs SET status = $2, "finishedAt" = now() WHERE id = $1', [runs.running, 'stopped'])
    await page.clock.fastForward(2_100)
  } finally { await check.end() }
  await expect(panel.getByText('已停止', { exact: true })).toBeVisible()
  await expect(threads.getByRole('button', { name: '打开线程 Trim the bundle', exact: true })).toContainText('已停止')
  await expect(panel.getByRole('textbox')).toHaveCount(0)
})
